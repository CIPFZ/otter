// Derived from mpegts.js@791bac89e2ea8cbebe7f7ba247c3b342c09418cc src/demux/flv-demuxer.js, Apache-2.0
/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Log from '../otter/shims.js';
import AMF, { type AmfValue } from './amf-parser.js';
import SPSParser from './sps-parser.js';
import DemuxErrors from './demux-errors.js';
import MediaInfo from '../core/media-info.js';
import {IllegalStateException} from '../otter/shims.js';
import H265Parser from './h265-parser.js';
import buffersAreEqual from '../utils/typedarray-equality.js';
import ExpGolomb from './exp-golomb.js';


// ---- Otter: types for the JS -> TS port (shapes as produced by the upstream code) ----------------

export interface FlvVideoUnit {
    type: number;
    data: Uint8Array;
}

export interface FlvVideoSample {
    units: FlvVideoUnit[];
    length: number;
    isKeyframe: boolean;
    /** Milliseconds (FLV timescale). */
    dts: number;
    cts: number;
    pts: number;
    fileposition?: number;
}

export interface FlvAudioSample {
    unit: Uint8Array;
    length: number;
    dts: number;
    pts: number;
}

export interface FlvTrack<S> {
    type: 'video' | 'audio';
    id: number;
    sequenceNumber: number;
    samples: S[];
    length: number;
}

export interface FlvFrameRate {
    fixed: boolean;
    fps: number;
    fps_num: number;
    fps_den: number;
}

/** Track metadata handed to onTrackMetadata (the fields upstream sets). */
export interface FlvTrackMeta {
    type: 'video' | 'audio';
    id: number;
    timescale: number;
    duration: number;
    codec?: string;
    originalCodec?: string;
    config?: number[] | Uint8Array;
    refSampleDuration?: number;
    audioSampleRate?: number;
    channelCount?: number;
    codecWidth?: number;
    codecHeight?: number;
    presentWidth?: number;
    presentHeight?: number;
    profile?: string;
    level?: string;
    bitDepth?: number;
    chromaFormat?: number;
    sarRatio?: { width: number; height: number };
    frameRate?: FlvFrameRate;
    avcc?: Uint8Array;
    hvcc?: Uint8Array;
}

export interface FlvProbeResult {
    match?: boolean;
    needMoreData?: boolean;
    consumed?: number;
    dataOffset?: number;
    hasAudioTrack?: boolean;
    hasVideoTrack?: boolean;
}

export interface AacSpecificConfig {
    config: number[];
    samplingRate: number;
    channelCount: number;
    codec: string;
    originalCodec: string;
}

export type AacPacket = { packetType: 0; data: AacSpecificConfig | undefined } | { packetType: number; data: Uint8Array };

export type FlvErrorHandler = (type: string, info: string) => void;
export type FlvTrackMetadataHandler = (type: 'video' | 'audio', meta: FlvTrackMeta) => void;
export type FlvDataHandler = (audioTrack: FlvTrack<FlvAudioSample>, videoTrack: FlvTrack<FlvVideoSample>) => void;
export type FlvMediaInfoHandler = (info: MediaInfo) => void;
export type FlvScriptDataHandler = (data: Record<string, AmfValue>) => void;

function Swap16(src: number): number {
    return (((src >>> 8) & 0xFF) |
            ((src & 0xFF) << 8));
}

function Swap32(src: number): number {
    return (((src & 0xFF000000) >>> 24) |
            ((src & 0x00FF0000) >>> 8)  |
            ((src & 0x0000FF00) << 8)   |
            ((src & 0x000000FF) << 24));
}

function ReadBig32(array: Uint8Array, index: number): number {
    return ((array[index]! << 24)     |
            (array[index + 1]! << 16) |
            (array[index + 2]! << 8)  |
            (array[index + 3]!));
}


class FLVDemuxer {
    // Otter: field declarations (JS -> TS).
    TAG: string;
    private _config: Record<string, unknown>;
    private _onError: FlvErrorHandler | null;
    private _onMediaInfo: FlvMediaInfoHandler | null;
    private _onMetaDataArrived: FlvScriptDataHandler | null;
    private _onScriptDataArrived: FlvScriptDataHandler | null;
    private _onTrackMetadata: FlvTrackMetadataHandler | null;
    private _onDataAvailable: FlvDataHandler | null;
    private _onSeiArrived: ((data: unknown) => void) | null;
    private _dataOffset: number;
    private _firstParse: boolean;
    private _dispatch: boolean;
    private _hasAudio: boolean;
    private _hasVideo: boolean;
    private _hasAudioFlagOverrided: boolean;
    private _hasVideoFlagOverrided: boolean;
    private _audioInitialMetadataDispatched: boolean;
    private _videoInitialMetadataDispatched: boolean;
    private _mediaInfo: MediaInfo;
    private _metadata: Record<string, AmfValue> | null;
    private _audioMetadata: FlvTrackMeta | null;
    private _videoMetadata: FlvTrackMeta | null;
    private _naluLengthSize: number;
    private _timestampBase: number;
    private _timescale: number;
    private _duration: number;
    private _durationOverrided: boolean;
    private _referenceFrameRate: FlvFrameRate;
    private _flvSoundRateTable: number[];
    private _mpegSamplingRates: number[];
    private _mpegAudioV10SampleRateTable: number[];
    private _mpegAudioV20SampleRateTable: number[];
    private _mpegAudioV25SampleRateTable: number[];
    private _mpegAudioL1BitRateTable: number[];
    private _mpegAudioL2BitRateTable: number[];
    private _mpegAudioL3BitRateTable: number[];
    private _videoTrack: FlvTrack<FlvVideoSample>;
    private _audioTrack: FlvTrack<FlvAudioSample>;
    private _littleEndian: boolean;

    constructor(probeData: FlvProbeResult, config: Record<string, unknown>) {
        this.TAG = 'FLVDemuxer';

        this._config = config;

        this._onError = null;
        this._onMediaInfo = null;
        this._onMetaDataArrived = null;
        this._onScriptDataArrived = null;
        this._onTrackMetadata = null;
        this._onDataAvailable = null;
        this._onSeiArrived = null;

        this._dataOffset = probeData.dataOffset ?? 0;
        this._firstParse = true;
        this._dispatch = false;

        this._hasAudio = probeData.hasAudioTrack === true;
        this._hasVideo = probeData.hasVideoTrack === true;

        this._hasAudioFlagOverrided = false;
        this._hasVideoFlagOverrided = false;

        this._audioInitialMetadataDispatched = false;
        this._videoInitialMetadataDispatched = false;

        this._mediaInfo = new MediaInfo();
        this._mediaInfo.hasAudio = this._hasAudio;
        this._mediaInfo.hasVideo = this._hasVideo;
        this._metadata = null;
        this._audioMetadata = null;
        this._videoMetadata = null;

        this._naluLengthSize = 4;
        this._timestampBase = 0;  // int32, in milliseconds
        this._timescale = 1000;
        this._duration = 0;  // int32, in milliseconds
        this._durationOverrided = false;
        this._referenceFrameRate = {
            fixed: true,
            fps: 23.976,
            fps_num: 23976,
            fps_den: 1000
        };

        this._flvSoundRateTable = [5500, 11025, 22050, 44100, 48000];

        this._mpegSamplingRates = [
            96000, 88200, 64000, 48000, 44100, 32000,
            24000, 22050, 16000, 12000, 11025, 8000, 7350
        ];

        this._mpegAudioV10SampleRateTable = [44100, 48000, 32000, 0];
        this._mpegAudioV20SampleRateTable = [22050, 24000, 16000, 0];
        this._mpegAudioV25SampleRateTable = [11025, 12000, 8000,  0];

        this._mpegAudioL1BitRateTable = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1];
        this._mpegAudioL2BitRateTable = [0, 32, 48, 56,  64,  80,  96, 112, 128, 160, 192, 224, 256, 320, 384, -1];
        this._mpegAudioL3BitRateTable = [0, 32, 40, 48,  56,  64,  80,  96, 112, 128, 160, 192, 224, 256, 320, -1];

        this._videoTrack = {type: 'video', id: 1, sequenceNumber: 0, samples: [], length: 0};
        this._audioTrack = {type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0};

        this._littleEndian = (function () {
            let buf = new ArrayBuffer(2);
            (new DataView(buf)).setInt16(0, 256, true);  // little-endian write
            return (new Int16Array(buf))[0] === 256;  // platform-spec read, if equal then LE
        })();
    }

    destroy(): void {
        // Otter: upstream drops every reference; typed fields are cleared via casts.
        this._mediaInfo = null as unknown as MediaInfo;
        this._metadata = null;
        this._audioMetadata = null;
        this._videoMetadata = null;
        this._videoTrack = null as unknown as FlvTrack<FlvVideoSample>;
        this._audioTrack = null as unknown as FlvTrack<FlvAudioSample>;

        this._onError = null;
        this._onMediaInfo = null;
        this._onMetaDataArrived = null;
        this._onScriptDataArrived = null;
        this._onTrackMetadata = null;
        this._onDataAvailable = null;
        this._onSeiArrived = null;
    }

    static probe(buffer: ArrayBuffer | Uint8Array): FlvProbeResult {
        let data = new Uint8Array(buffer);
        if (data.byteLength < 9) {
            return {needMoreData: true};
        }

        let mismatch: FlvProbeResult = {match: false};

        if (data[0] !== 0x46 || data[1] !== 0x4C || data[2] !== 0x56 || data[3] !== 0x01) {
            return mismatch;
        }

        let hasAudio = ((data[4]! & 4) >>> 2) !== 0;
        let hasVideo = (data[4]! & 1) !== 0;

        let offset = ReadBig32(data, 5);

        if (offset < 9) {
            return mismatch;
        }

        return {
            match: true,
            consumed: offset,
            dataOffset: offset,
            hasAudioTrack: hasAudio,
            hasVideoTrack: hasVideo
        };
    }

    bindDataSource(loader: { onDataArrival: (chunk: ArrayBuffer, byteStart: number) => number }): this {
        loader.onDataArrival = this.parseChunks.bind(this);
        return this;
    }

    // prototype: function(type: string, metadata: any): void
    get onTrackMetadata() {
        return this._onTrackMetadata;
    }

    set onTrackMetadata(callback: (FlvTrackMetadataHandler) | null) {
        this._onTrackMetadata = callback;
    }

    // prototype: function(mediaInfo: MediaInfo): void
    get onMediaInfo() {
        return this._onMediaInfo;
    }

    set onMediaInfo(callback: (FlvMediaInfoHandler) | null) {
        this._onMediaInfo = callback;
    }

    get onMetaDataArrived() {
        return this._onMetaDataArrived;
    }

    set onMetaDataArrived(callback: (FlvScriptDataHandler) | null) {
        this._onMetaDataArrived = callback;
    }

    get onScriptDataArrived() {
        return this._onScriptDataArrived;
    }

    set onScriptDataArrived(callback: (FlvScriptDataHandler) | null) {
        this._onScriptDataArrived = callback;
    }

    get onSeiArrived() {
        return this._onSeiArrived
    }

    set onSeiArrived(callback: ((data: unknown) => void) | null) {
        this._onSeiArrived = callback;
    }

    // prototype: function(type: number, info: string): void
    get onError() {
        return this._onError;
    }

    set onError(callback: (FlvErrorHandler) | null) {
        this._onError = callback;
    }

    // prototype: function(videoTrack: any, audioTrack: any): void
    get onDataAvailable() {
        return this._onDataAvailable;
    }

    set onDataAvailable(callback: (FlvDataHandler) | null) {
        this._onDataAvailable = callback;
    }

    // timestamp base for output samples, must be in milliseconds
    get timestampBase() {
        return this._timestampBase;
    }

    set timestampBase(base: number) {
        this._timestampBase = base;
    }

    get overridedDuration() {
        return this._duration;
    }

    // Force-override media duration. Must be in milliseconds, int32
    set overridedDuration(duration: number) {
        this._durationOverrided = true;
        this._duration = duration;
        this._mediaInfo.duration = duration;
    }

    // Force-override audio track present flag, boolean
    set overridedHasAudio(hasAudio: boolean) {
        this._hasAudioFlagOverrided = true;
        this._hasAudio = hasAudio;
        this._mediaInfo.hasAudio = hasAudio;
    }

    // Force-override video track present flag, boolean
    set overridedHasVideo(hasVideo: boolean) {
        this._hasVideoFlagOverrided = true;
        this._hasVideo = hasVideo;
        this._mediaInfo.hasVideo = hasVideo;
    }

    resetMediaInfo() {
        this._mediaInfo = new MediaInfo();
    }

    _isInitialMetadataDispatched() {
        if (this._hasAudio && this._hasVideo) {  // both audio & video
            return this._audioInitialMetadataDispatched && this._videoInitialMetadataDispatched;
        }
        if (this._hasAudio && !this._hasVideo) {  // audio only
            return this._audioInitialMetadataDispatched;
        }
        if (!this._hasAudio && this._hasVideo) {  // video only
            return this._videoInitialMetadataDispatched;
        }
        return false;
    }

    // function parseChunks(chunk: ArrayBuffer, byteStart: number): number;
    parseChunks(chunk: ArrayBuffer, byteStart: number): number {
        if (!this._onError || !this._onMediaInfo || !this._onTrackMetadata || !this._onDataAvailable) {
            throw new IllegalStateException('Flv: onError & onMediaInfo & onTrackMetadata & onDataAvailable callback must be specified');
        }

        let offset = 0;
        let le = this._littleEndian;

        if (byteStart === 0) {  // buffer with FLV header
            if (chunk.byteLength > 13) {
                let probeData = FLVDemuxer.probe(chunk);
                offset = probeData.dataOffset ?? 0;
            } else {
                return 0;
            }
        }

        if (this._firstParse) {  // handle PreviousTagSize0 before Tag1
            this._firstParse = false;
            if (byteStart + offset !== this._dataOffset) {
                Log.w(this.TAG, 'First time parsing but chunk byteStart invalid!');
            }

            let v = new DataView(chunk, offset);
            let prevTagSize0 = v.getUint32(0, !le);
            if (prevTagSize0 !== 0) {
                Log.w(this.TAG, 'PrevTagSize0 !== 0 !!!');
            }
            offset += 4;
        }

        while (offset < chunk.byteLength) {
            this._dispatch = true;

            let v = new DataView(chunk, offset);

            if (offset + 11 + 4 > chunk.byteLength) {
                // data not enough for parsing an flv tag
                break;
            }

            let tagType = v.getUint8(0);
            let dataSize = v.getUint32(0, !le) & 0x00FFFFFF;

            if (offset + 11 + dataSize + 4 > chunk.byteLength) {
                // data not enough for parsing actual data body
                break;
            }

            if (tagType !== 8 && tagType !== 9 && tagType !== 18) {
                Log.w(this.TAG, `Unsupported tag type ${tagType}, skipped`);
                // consume the whole tag (skip it)
                offset += 11 + dataSize + 4;
                continue;
            }

            let ts2 = v.getUint8(4);
            let ts1 = v.getUint8(5);
            let ts0 = v.getUint8(6);
            let ts3 = v.getUint8(7);

            let timestamp = ts0 | (ts1 << 8) | (ts2 << 16) | (ts3 << 24);

            let streamId = v.getUint32(7, !le) & 0x00FFFFFF;
            if (streamId !== 0) {
                Log.w(this.TAG, 'Meet tag which has StreamID != 0!');
            }

            let dataOffset = offset + 11;

            switch (tagType) {
                case 8:  // Audio
                    this._parseAudioData(chunk, dataOffset, dataSize, timestamp);
                    break;
                case 9:  // Video
                    this._parseVideoData(chunk, dataOffset, dataSize, timestamp, byteStart + offset);
                    break;
                case 18:  // ScriptDataObject
                    this._parseScriptData(chunk, dataOffset, dataSize);
                    break;
            }

            let prevTagSize = v.getUint32(11 + dataSize, !le);
            if (prevTagSize !== 11 + dataSize) {
                Log.w(this.TAG, `Invalid PrevTagSize ${prevTagSize}`);
            }

            offset += 11 + dataSize + 4;  // tagBody + dataSize + prevTagSize
        }

        // dispatch parsed frames to consumer (typically, the remuxer)
        if (this._isInitialMetadataDispatched()) {
            if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
                this._onDataAvailable!(this._audioTrack, this._videoTrack);
            }
        }

        return offset;  // consumed bytes, just equals latest offset index
    }

    _parseScriptData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number): void {
        let scriptData = AMF.parseScriptData(arrayBuffer, dataOffset, dataSize);

        if (scriptData.hasOwnProperty('onMetaData')) {
            if (scriptData.onMetaData == null || typeof scriptData.onMetaData !== 'object') {
                Log.w(this.TAG, 'Invalid onMetaData structure!');
                return;
            }
            if (this._metadata) {
                Log.w(this.TAG, 'Found another onMetaData tag!');
            }
            this._metadata = scriptData;
            let onMetaData = this._metadata.onMetaData as { [key: string]: AmfValue };

            if (this._onMetaDataArrived) {
                this._onMetaDataArrived(Object.assign({}, onMetaData));
            }

            if (typeof onMetaData.hasAudio === 'boolean') {  // hasAudio
                if (this._hasAudioFlagOverrided === false) {
                    this._hasAudio = onMetaData.hasAudio;
                    this._mediaInfo.hasAudio = this._hasAudio;
                }
            }
            if (typeof onMetaData.hasVideo === 'boolean') {  // hasVideo
                if (this._hasVideoFlagOverrided === false) {
                    this._hasVideo = onMetaData.hasVideo;
                    this._mediaInfo.hasVideo = this._hasVideo;
                }
            }
            if (typeof onMetaData.audiodatarate === 'number') {  // audiodatarate
                this._mediaInfo.audioDataRate = onMetaData.audiodatarate;
            }
            if (typeof onMetaData.videodatarate === 'number') {  // videodatarate
                this._mediaInfo.videoDataRate = onMetaData.videodatarate;
            }
            if (typeof onMetaData.width === 'number') {  // width
                this._mediaInfo.width = onMetaData.width;
            }
            if (typeof onMetaData.height === 'number') {  // height
                this._mediaInfo.height = onMetaData.height;
            }
            if (typeof onMetaData.duration === 'number') {  // duration
                if (!this._durationOverrided) {
                    let duration = Math.floor(onMetaData.duration * this._timescale);
                    this._duration = duration;
                    this._mediaInfo.duration = duration;
                }
            } else {
                this._mediaInfo.duration = 0;
            }
            if (typeof onMetaData.framerate === 'number') {  // framerate
                let fps_num = Math.floor(onMetaData.framerate * 1000);
                if (fps_num > 0) {
                    let fps = fps_num / 1000;
                    this._referenceFrameRate.fixed = true;
                    this._referenceFrameRate.fps = fps;
                    this._referenceFrameRate.fps_num = fps_num;
                    this._referenceFrameRate.fps_den = 1000;
                    this._mediaInfo.fps = fps;
                }
            }
            if (typeof onMetaData.keyframes === 'object') {  // keyframes
                this._mediaInfo.hasKeyframesIndex = true;
                let keyframes = onMetaData.keyframes as unknown as { times: number[]; filepositions: number[] };
                this._mediaInfo.keyframesIndex = this._parseKeyframesIndex(keyframes);
                delete onMetaData.keyframes;  // keyframes has been extracted, remove it (Otter: delete instead of = null)
            } else {
                this._mediaInfo.hasKeyframesIndex = false;
            }
            this._dispatch = false;
            this._mediaInfo.metadata = onMetaData;
            Log.v(this.TAG, 'Parsed onMetaData');
            if (this._mediaInfo.isComplete()) {
                this._onMediaInfo!(this._mediaInfo);
            }
        }

        if (Object.keys(scriptData).length > 0) {
            if (this._onScriptDataArrived) {
                this._onScriptDataArrived(Object.assign({}, scriptData));
            }
        }
    }

    // Otter: SEI parsing (mpegts.js sei.ts) is not copied; SEI NAL units stay in the samples.
    _parseSEIPayload(_data: Uint8Array, _pts: number, _codec: string): void {}

    _parseKeyframesIndex(keyframes: { times: number[]; filepositions: number[] }): { times: number[]; filepositions: number[] } {
        let times: number[] = [];
        let filepositions: number[] = [];

        // ignore first keyframe which is actually AVC/HEVC Sequence Header (AVCDecoderConfigurationRecord or HEVCDecoderConfigurationRecord)
        for (let i = 1; i < keyframes.times.length; i++) {
            let time = this._timestampBase + Math.floor(keyframes.times[i]! * 1000);
            times.push(time);
            filepositions.push(keyframes.filepositions[i]!);
        }

        return {
            times: times,
            filepositions: filepositions
        };
    }

    _parseAudioData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number): void {
        if (dataSize <= 1) {
            Log.w(this.TAG, 'Flv: Invalid audio packet, missing SoundData payload!');
            return;
        }

        if (this._hasAudioFlagOverrided === true && this._hasAudio === false) {
            // If hasAudio: false indicated explicitly in MediaDataSource,
            // Ignore all the audio packets
            return;
        }

        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        let soundSpec = v.getUint8(0);

        let soundFormat = soundSpec >>> 4;
        if (soundFormat === 9) { // Enhanced FLV
            if (dataSize <= 5) {
                Log.w(this.TAG, 'Flv: Invalid audio packet, missing AudioFourCC in Ehnanced FLV payload!');
                return;
            }
            let packetType = soundSpec & 0x0F;
            let fourcc = String.fromCharCode(... (new Uint8Array(arrayBuffer, dataOffset, dataSize)).slice(1, 5));

            // Otter: Enhanced FLV audio (Opus / FLAC) is not supported by the Otter pipeline.
            void packetType;
            this._onError!(DemuxErrors.CODEC_UNSUPPORTED, 'Flv: Unsupported audio codec: ' + fourcc);

            return;
        }
        // Legacy FLV

        if (soundFormat !== 10) {  // Otter: AAC only (MP3 / PCM removed)
            this._onError!(DemuxErrors.CODEC_UNSUPPORTED, 'Flv: Unsupported audio codec idx: ' + soundFormat);
            return;
        }

        let soundRate = 0;
        let soundRateIndex = (soundSpec & 12) >>> 2;
        if (soundRateIndex >= 0 && soundRateIndex <= 4) {
            soundRate = this._flvSoundRateTable[soundRateIndex]!;
        } else {
            this._onError!(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid audio sample rate idx: ' + soundRateIndex);
            return;
        }

        let soundSize = (soundSpec & 2) >>> 1;  // unused
        let soundType = (soundSpec & 1);

        let meta = this._audioMetadata;
        let track = this._audioTrack;

        if (!meta) {
            if (this._hasAudio === false && this._hasAudioFlagOverrided === false) {
                this._hasAudio = true;
                this._mediaInfo.hasAudio = true;
            }

            // initial metadata
            meta = this._audioMetadata = {} as FlvTrackMeta;
            meta.type = 'audio';
            meta.id = track.id;
            meta.timescale = this._timescale;
            meta.duration = this._duration;
            meta.audioSampleRate = soundRate;
            meta.channelCount = (soundType === 0 ? 1 : 2);
        }

        if (soundFormat === 10) {  // AAC
            let aacData = this._parseAACAudioData(arrayBuffer, dataOffset + 1, dataSize - 1);
            if (aacData == undefined) {
                return;
            }

            if (aacData.packetType === 0) {  // AAC sequence header (AudioSpecificConfig)
                if (aacData.data === undefined || aacData.data instanceof Uint8Array) {
                    return;  // Otter: invalid config (upstream would throw on .config)
                }
                if (meta.config) {
                    // Otter: compare as bytes. Upstream passes number[] to buffersAreEqual, where
                    // byteLength is undefined on both sides, so configs of different lengths with an
                    // equal prefix compared equal.
                    if (buffersAreEqual(Uint8Array.from(aacData.data.config), Uint8Array.from(meta.config))) {
                        // If AudioSpecificConfig is not changed, ignore it to avoid generating initialization segment repeatedly
                        return;
                    } else {
                        Log.w(this.TAG, 'AudioSpecificConfig has been changed, re-generate initialization segment');
                    }
                }
                let misc: AacSpecificConfig = aacData.data;
                meta.audioSampleRate = misc.samplingRate;
                meta.channelCount = misc.channelCount;
                meta.codec = misc.codec;
                meta.originalCodec = misc.originalCodec;
                meta.config = misc.config;
                // The decode result of an aac sample is 1024 PCM samples
                meta.refSampleDuration = 1024 / misc.samplingRate * meta.timescale;
                Log.v(this.TAG, 'Parsed AudioSpecificConfig');

                if (this._isInitialMetadataDispatched()) {
                    // Non-initial metadata, force dispatch (or flush) parsed frames to remuxer
                    if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
                        this._onDataAvailable!(this._audioTrack, this._videoTrack);
                    }
                } else {
                    this._audioInitialMetadataDispatched = true;
                }
                // then notify new metadata
                this._dispatch = false;
                this._onTrackMetadata!('audio', meta);

                let mi = this._mediaInfo;
                mi.audioCodec = misc.originalCodec;
                mi.audioSampleRate = misc.samplingRate;
                mi.audioChannelCount = misc.channelCount;
                if (mi.hasVideo) {
                    if (mi.videoCodec != null) {
                        mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                    }
                } else {
                    mi.mimeType = 'video/x-flv; codecs="' + mi.audioCodec + '"';
                }
                if (mi.isComplete()) {
                    this._onMediaInfo!(mi);
                }
            } else if (aacData.packetType === 1 && aacData.data instanceof Uint8Array) {  // AAC raw frame data
                let dts = this._timestampBase + tagTimestamp;
                let aacSample = {unit: aacData.data, length: aacData.data.byteLength, dts: dts, pts: dts};
                track.samples.push(aacSample);
                track.length += aacData.data.length;
            } else {
                Log.e(this.TAG, `Flv: Unsupported AAC data type ${aacData.packetType}`);
            }
        } else {
            // Otter: MP3 / PCM in FLV are not supported by the Otter pipeline (AAC only); such
            // streams stay on the mpegts.js adapter (ADR-007 §2).
            this._onError!(DemuxErrors.CODEC_UNSUPPORTED, 'Flv: Unsupported audio codec idx: ' + soundFormat);
        }
    }

    _parseAACAudioData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number) {
        if (dataSize <= 1) {
            Log.w(this.TAG, 'Flv: Invalid AAC packet, missing AACPacketType or/and Data!');
            return;
        }

        let array = new Uint8Array(arrayBuffer, dataOffset, dataSize);

        // Otter: discriminated result instead of a mutated {} (same values).
        let result: AacPacket;
        if (array[0] === 0) {
            result = { packetType: 0, data: this._parseAACAudioSpecificConfig(arrayBuffer, dataOffset + 1, dataSize - 1) };
        } else {
            result = { packetType: array[0]!, data: array.subarray(1) };
        }

        return result;
    }

    _parseAACAudioSpecificConfig(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number): AacSpecificConfig | undefined {
        let array = new Uint8Array(arrayBuffer, dataOffset, dataSize);
        let config: number[] = [];

        /* Audio Object Type:
           0: Null
           1: AAC Main
           2: AAC LC
           3: AAC SSR (Scalable Sample Rate)
           4: AAC LTP (Long Term Prediction)
           5: HE-AAC / SBR (Spectral Band Replication)
           6: AAC Scalable
        */

        let audioObjectType = 0;
        let originalAudioObjectType = 0;
        let audioExtensionObjectType = null;
        let samplingIndex = 0;
        let extensionSamplingIndex = null;

        // 5 bits
        audioObjectType = originalAudioObjectType = array[0]! >>> 3;
        // 4 bits
        samplingIndex = ((array[0]! & 0x07) << 1) | (array[1]! >>> 7);
        if (samplingIndex < 0 || samplingIndex >= this._mpegSamplingRates.length) {
            this._onError!(DemuxErrors.FORMAT_ERROR, 'Flv: AAC invalid sampling frequency index!');
            return;
        }

        let samplingFrequence = this._mpegSamplingRates[samplingIndex];

        // 4 bits
        let channelConfig = (array[1]! & 0x78) >>> 3;
        if (channelConfig < 0 || channelConfig >= 8) {
            this._onError!(DemuxErrors.FORMAT_ERROR, 'Flv: AAC invalid channel configuration');
            return;
        }

        if (audioObjectType === 5) {  // HE-AAC?
            // 4 bits
            extensionSamplingIndex = ((array[1]! & 0x07) << 1) | (array[2]! >>> 7);
            // 5 bits
            audioExtensionObjectType = (array[2]! & 0x7C) >>> 2;
        }

        // workarounds for various browsers
        // Otter: no global `self` outside browsers / workers.
        let userAgent = (typeof navigator !== 'undefined' ? navigator.userAgent : '').toLowerCase();

        if (userAgent.indexOf('firefox') !== -1) {
            // firefox: use SBR (HE-AAC) if freq less than 24kHz
            if (samplingIndex >= 6) {
                audioObjectType = 5;
                config = new Array(4);
                extensionSamplingIndex = samplingIndex - 3;
            } else {  // use LC-AAC
                audioObjectType = 2;
                config = new Array(2);
                extensionSamplingIndex = samplingIndex;
            }
        } else if (userAgent.indexOf('android') !== -1) {
            // android: always use LC-AAC
            audioObjectType = 2;
            config = new Array(2);
            extensionSamplingIndex = samplingIndex;
        } else {
            // for other browsers, e.g. chrome...
            // Always use HE-AAC to make it easier to switch aac codec profile
            audioObjectType = 5;
            extensionSamplingIndex = samplingIndex;
            config = new Array(4);

            if (samplingIndex >= 6) {
                extensionSamplingIndex = samplingIndex - 3;
            } else if (channelConfig === 1) {  // Mono channel
                audioObjectType = 2;
                config = new Array(2);
                extensionSamplingIndex = samplingIndex;
            }
        }

        config[0]  = audioObjectType << 3;
        config[0] |= (samplingIndex & 0x0F) >>> 1;
        config[1]  = (samplingIndex & 0x0F) << 7;
        config[1] |= (channelConfig & 0x0F) << 3;
        if (audioObjectType === 5) {
            config[1] |= ((extensionSamplingIndex & 0x0F) >>> 1);
            config[2]  = (extensionSamplingIndex & 0x01) << 7;
            // extended audio object type: force to 2 (LC-AAC)
            config[2] |= (2 << 2);
            config[3]  = 0;
        }

        return {
            config: config,
            samplingRate: samplingFrequence!,
            channelCount: channelConfig,
            codec: 'mp4a.40.' + audioObjectType,
            originalCodec: 'mp4a.40.' + originalAudioObjectType
        };
    }

    _parseVideoData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number): void {
        if (dataSize <= 1) {
            Log.w(this.TAG, 'Flv: Invalid video packet, missing VideoData payload!');
            return;
        }

        if (this._hasVideoFlagOverrided === true && this._hasVideo === false) {
            // If hasVideo: false indicated explicitly in MediaDataSource,
            // Ignore all the video packets
            return;
        }

        let spec = (new Uint8Array(arrayBuffer, dataOffset, dataSize))[0]!;

        let isExHeader = (spec & 0b10000000) !== 0;
        let frameType = (spec & 0b01110000) >>> 4;

        if (!isExHeader) {
            let codecId = spec & 0b00001111;
            if (codecId === 7) { // AVC
                this._parseAVCVideoPacket(arrayBuffer, dataOffset + 1, dataSize - 1, tagTimestamp, tagPosition, frameType);
            } else if (codecId === 12) { // HEVC
                this._parseHEVCVideoPacket(arrayBuffer, dataOffset + 1, dataSize - 1, tagTimestamp, tagPosition, frameType);
            } else {
                this._onError!(DemuxErrors.CODEC_UNSUPPORTED, `Flv: Unsupported codec in video frame: ${codecId}`);
                return;
            }
        } else {
            let packetType = spec & 0b00001111;
            let fourcc = String.fromCharCode(... (new Uint8Array(arrayBuffer, dataOffset, dataSize)).slice(1, 5));

            if (fourcc === 'hvc1') { // HEVC
                this._parseEnhancedHEVCVideoPacket(arrayBuffer, dataOffset + 5, dataSize - 5, tagTimestamp, tagPosition, frameType, packetType);
            } else {  // Otter: Enhanced FLV AV1 is not supported by the Otter pipeline.
                this._onError!(DemuxErrors.CODEC_UNSUPPORTED, `Flv: Unsupported codec in video frame: ${fourcc}`);
                return;
            }
        }
    }

    _parseAVCVideoPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number): void {
        if (dataSize < 4) {
            Log.w(this.TAG, 'Flv: Invalid AVC packet, missing AVCPacketType or/and CompositionTime');
            return;
        }

        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        let packetType = v.getUint8(0);
        let cts_unsigned = v.getUint32(0, !le) & 0x00FFFFFF;
        let cts = (cts_unsigned << 8) >> 8;  // convert to 24-bit signed int

        if (packetType === 0) {  // AVCDecoderConfigurationRecord
            this._parseAVCDecoderConfigurationRecord(arrayBuffer, dataOffset + 4, dataSize - 4);
        } else if (packetType === 1) {  // One or more Nalus
            this._parseAVCVideoData(arrayBuffer, dataOffset + 4, dataSize - 4, tagTimestamp, tagPosition, frameType, cts);
        } else if (packetType === 2) {
            // empty, AVC end of sequence
        } else {
            this._onError!(DemuxErrors.FORMAT_ERROR, `Flv: Invalid video packet type ${packetType}`);
            return;
        }
    }

    _parseHEVCVideoPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number): void {
        if (dataSize < 4) {
            Log.w(this.TAG, 'Flv: Invalid HEVC packet, missing HEVCPacketType or/and CompositionTime');
            return;
        }

        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        let packetType = v.getUint8(0);
        let cts_unsigned = v.getUint32(0, !le) & 0x00FFFFFF;
        let cts = (cts_unsigned << 8) >> 8;  // convert to 24-bit signed int

        if (packetType === 0) {  // HEVCDecoderConfigurationRecord
            this._parseHEVCDecoderConfigurationRecord(arrayBuffer, dataOffset + 4, dataSize - 4);
        } else if (packetType === 1) {  // One or more Nalus
            this._parseHEVCVideoData(arrayBuffer, dataOffset + 4, dataSize - 4, tagTimestamp, tagPosition, frameType, cts);
        } else if (packetType === 2) {
            // empty, HEVC end of sequence
        } else {
            this._onError!(DemuxErrors.FORMAT_ERROR, `Flv: Invalid video packet type ${packetType}`);
            return;
        }
    }

    _parseEnhancedHEVCVideoPacket(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number, packetType: number): void {
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        if (packetType === 0) {  // HEVCDecoderConfigurationRecord
            this._parseHEVCDecoderConfigurationRecord(arrayBuffer, dataOffset, dataSize);
        } else if (packetType === 1) {  // One or more Nalus
            let cts_unsigned = v.getUint32(0, !le) & 0xFFFFFF00;
            let cts = cts_unsigned >> 8;  // convert to 24-bit signed int

            this._parseHEVCVideoData(arrayBuffer, dataOffset + 3, dataSize - 3, tagTimestamp, tagPosition, frameType, cts);
        } else if (packetType === 3) {
            this._parseHEVCVideoData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType, 0);
        } else if (packetType === 2) {
            // empty, HEVC end of sequence
        } else {
            this._onError!(DemuxErrors.FORMAT_ERROR, `Flv: Invalid video packet type ${packetType}`);
            return;
        }
    }

    _parseAVCDecoderConfigurationRecord(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number): void {
        if (dataSize < 7) {
            Log.w(this.TAG, 'Flv: Invalid AVCDecoderConfigurationRecord, lack of data!');
            return;
        }

        let meta = this._videoMetadata;
        let track = this._videoTrack;
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        if (!meta) {
            if (this._hasVideo === false && this._hasVideoFlagOverrided === false) {
                this._hasVideo = true;
                this._mediaInfo.hasVideo = true;
            }

            meta = this._videoMetadata = {} as FlvTrackMeta;
            meta.type = 'video';
            meta.id = track.id;
            meta.timescale = this._timescale;
            meta.duration = this._duration;
        } else {
            if (typeof meta.avcc !== 'undefined') {
                let new_avcc = new Uint8Array(arrayBuffer, dataOffset, dataSize);
                if (buffersAreEqual(new_avcc, meta.avcc)) {
                    // AVCDecoderConfigurationRecord is not changed, ignore it to avoid initialization segment re-generating
                    return;
                } else {
                    Log.w(this.TAG, 'AVCDecoderConfigurationRecord has been changed, re-generate initialization segment');
                }
            }
        }

        let version = v.getUint8(0);  // configurationVersion
        let avcProfile = v.getUint8(1);  // avcProfileIndication
        let profileCompatibility = v.getUint8(2);  // profile_compatibility
        let avcLevel = v.getUint8(3);  // AVCLevelIndication

        if (version !== 1 || avcProfile === 0) {
            this._onError!(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AVCDecoderConfigurationRecord');
            return;
        }

        this._naluLengthSize = (v.getUint8(4) & 3) + 1;  // lengthSizeMinusOne
        if (this._naluLengthSize !== 3 && this._naluLengthSize !== 4) {  // holy shit!!!
            this._onError!(DemuxErrors.FORMAT_ERROR, `Flv: Strange NaluLengthSizeMinusOne: ${this._naluLengthSize - 1}`);
            return;
        }

        let spsCount = v.getUint8(5) & 31;  // numOfSequenceParameterSets
        if (spsCount === 0) {
            this._onError!(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AVCDecoderConfigurationRecord: No SPS');
            return;
        } else if (spsCount > 1) {
            Log.w(this.TAG, `Flv: Strange AVCDecoderConfigurationRecord: SPS Count = ${spsCount}`);
        }

        let offset = 6;

        for (let i = 0; i < spsCount; i++) {
            let len = v.getUint16(offset, !le);  // sequenceParameterSetLength
            offset += 2;

            if (len === 0) {
                continue;
            }

            // Notice: Nalu without startcode header (00 00 00 01)
            let sps = new Uint8Array(arrayBuffer, dataOffset + offset, len);
            offset += len;

            let config = SPSParser.parseSPS(sps);
            if (i !== 0) {
                // ignore other sps's config
                continue;
            }

            meta.codecWidth = config.codec_size.width;
            meta.codecHeight = config.codec_size.height;
            meta.presentWidth = config.present_size.width;
            meta.presentHeight = config.present_size.height;

            meta.profile = config.profile_string;
            meta.level = config.level_string;
            meta.bitDepth = config.bit_depth;
            meta.chromaFormat = config.chroma_format;
            meta.sarRatio = config.sar_ratio;
            meta.frameRate = config.frame_rate;

            if (config.frame_rate.fixed === false ||
                config.frame_rate.fps_num === 0 ||
                config.frame_rate.fps_den === 0) {
                meta.frameRate = this._referenceFrameRate;
            }

            let fps_den = meta.frameRate.fps_den;
            let fps_num = meta.frameRate.fps_num;
            meta.refSampleDuration = meta.timescale * (fps_den / fps_num);

            let codecArray = sps.subarray(1, 4);
            let codecString = 'avc1.';
            for (let j = 0; j < 3; j++) {
                let h = codecArray[j]!.toString(16);
                if (h.length < 2) {
                    h = '0' + h;
                }
                codecString += h;
            }
            meta.codec = codecString;

            let mi = this._mediaInfo;
            mi.width = meta.codecWidth;
            mi.height = meta.codecHeight;
            mi.fps = meta.frameRate.fps;
            mi.profile = meta.profile;
            mi.level = meta.level;
            mi.refFrames = config.ref_frames;
            mi.chromaFormat = config.chroma_format_string;
            mi.sarNum = meta.sarRatio.width;
            mi.sarDen = meta.sarRatio.height;
            mi.videoCodec = codecString;

            if (mi.hasAudio) {
                if (mi.audioCodec != null) {
                    mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                }
            } else {
                mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + '"';
            }
            if (mi.isComplete()) {
                this._onMediaInfo!(mi);
            }
        }

        let ppsCount = v.getUint8(offset);  // numOfPictureParameterSets
        if (ppsCount === 0) {
            this._onError!(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AVCDecoderConfigurationRecord: No PPS');
            return;
        } else if (ppsCount > 1) {
            Log.w(this.TAG, `Flv: Strange AVCDecoderConfigurationRecord: PPS Count = ${ppsCount}`);
        }

        offset++;

        for (let i = 0; i < ppsCount; i++) {
            let len = v.getUint16(offset, !le);  // pictureParameterSetLength
            offset += 2;

            if (len === 0) {
                continue;
            }

            // pps is useless for extracting video information
            offset += len;
        }

        meta.avcc = new Uint8Array(dataSize);
        meta.avcc.set(new Uint8Array(arrayBuffer, dataOffset, dataSize), 0);
        Log.v(this.TAG, 'Parsed AVCDecoderConfigurationRecord');

        if (this._isInitialMetadataDispatched()) {
            // flush parsed frames
            if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
                this._onDataAvailable!(this._audioTrack, this._videoTrack);
            }
        } else {
            this._videoInitialMetadataDispatched = true;
        }
        // notify new metadata
        this._dispatch = false;
        this._onTrackMetadata!('video', meta);
    }

    _parseHEVCDecoderConfigurationRecord(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number): void {
        if (dataSize < 22) {
            Log.w(this.TAG, 'Flv: Invalid HEVCDecoderConfigurationRecord, lack of data!');
            return;
        }

        let meta = this._videoMetadata;
        let track = this._videoTrack;
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        if (!meta) {
            if (this._hasVideo === false && this._hasVideoFlagOverrided === false) {
                this._hasVideo = true;
                this._mediaInfo.hasVideo = true;
            }

            meta = this._videoMetadata = {} as FlvTrackMeta;
            meta.type = 'video';
            meta.id = track.id;
            meta.timescale = this._timescale;
            meta.duration = this._duration;
        } else {
            if (typeof meta.hvcc !== 'undefined') {
                let new_hvcc = new Uint8Array(arrayBuffer, dataOffset, dataSize);
                if (buffersAreEqual(new_hvcc, meta.hvcc)) {
                    // HEVCDecoderConfigurationRecord not changed, ignore it to avoid initialization segment re-generating
                    return;
                } else {
                    Log.w(this.TAG, 'HEVCDecoderConfigurationRecord has been changed, re-generate initialization segment');
                }
            }
        }

        let version = v.getUint8(0);  // configurationVersion
        let hevcProfile = v.getUint8(1) & 0x1F;  // hevcProfileIndication

        if ((version !== 0 && version !== 1) || hevcProfile === 0) {
            this._onError!(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid HEVCDecoderConfigurationRecord');
            return;
        }

        this._naluLengthSize = (v.getUint8(21) & 3) + 1;  // lengthSizeMinusOne
        if (this._naluLengthSize !== 3 && this._naluLengthSize !== 4) {  // holy shit!!!
            this._onError!(DemuxErrors.FORMAT_ERROR, `Flv: Strange NaluLengthSizeMinusOne: ${this._naluLengthSize - 1}`);
            return;
        }

        let numOfArrays = v.getUint8(22);
        for (let i = 0, offset = 23; i < numOfArrays; i++) {
            let nalUnitType = v.getUint8(offset + 0) & 0x3F;
            let numNalus = v.getUint16(offset + 1, !le);

            offset += 3;
            for (let j = 0; j < numNalus; j++) {
                let len = v.getUint16(offset + 0, !le);
                if (j !== 0) {
                    offset += 2 + len;
                    continue;
                }

                if (nalUnitType === 33) {
                    offset += 2;
                    let sps = new Uint8Array(arrayBuffer, dataOffset + offset, len);

                    let config = H265Parser.parseSPS(sps);
                    meta.codecWidth = config.codec_size.width;
                    meta.codecHeight = config.codec_size.height;
                    meta.presentWidth = config.present_size.width;
                    meta.presentHeight = config.present_size.height;

                    meta.profile = config.profile_string;
                    meta.level = config.level_string;
                    meta.bitDepth = config.bit_depth;
                    meta.chromaFormat = config.chroma_format;
                    meta.sarRatio = config.sar_ratio;
                    meta.frameRate = config.frame_rate;

                    if (config.frame_rate.fixed === false ||
                        config.frame_rate.fps_num === 0 ||
                        config.frame_rate.fps_den === 0) {
                        meta.frameRate = this._referenceFrameRate;
                    }

                    let fps_den = meta.frameRate.fps_den;
                    let fps_num = meta.frameRate.fps_num;
                    meta.refSampleDuration = meta.timescale * (fps_den / fps_num);
                    meta.codec = config.codec_mimetype;

                    let mi = this._mediaInfo;
                    mi.width = meta.codecWidth;
                    mi.height = meta.codecHeight;
                    mi.fps = meta.frameRate.fps;
                    mi.profile = meta.profile;
                    mi.level = meta.level;
                    mi.refFrames = config.ref_frames;
                    mi.chromaFormat = config.chroma_format_string;
                    mi.sarNum = meta.sarRatio.width;
                    mi.sarDen = meta.sarRatio.height;
                    mi.videoCodec = config.codec_mimetype;

                    if (mi.hasAudio) {
                        if (mi.audioCodec != null) {
                            mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                        }
                    } else {
                        mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + '"';
                    }
                    if (mi.isComplete()) {
                        this._onMediaInfo!(mi);
                    }

                    offset += len;
                } else {
                    offset += 2 + len;
                }
            }
        }

        meta.hvcc = new Uint8Array(dataSize);
        meta.hvcc.set(new Uint8Array(arrayBuffer, dataOffset, dataSize), 0);
        Log.v(this.TAG, 'Parsed HEVCDecoderConfigurationRecord');

        if (this._isInitialMetadataDispatched()) {
            // flush parsed frames
            if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
                this._onDataAvailable!(this._audioTrack, this._videoTrack);
            }
        } else {
            this._videoInitialMetadataDispatched = true;
        }
        // notify new metadata
        this._dispatch = false;
        this._onTrackMetadata!('video', meta);
    }

    _parseAVCVideoData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number, cts: number): void {
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        let units = [], length = 0;

        let offset = 0;
        const lengthSize = this._naluLengthSize;
        let dts = this._timestampBase + tagTimestamp;
        let keyframe = (frameType === 1);  // from FLV Frame Type constants

        while (offset < dataSize) {
            if (offset + 4 >= dataSize) {
                Log.w(this.TAG, `Malformed Nalu near timestamp ${dts}, offset = ${offset}, dataSize = ${dataSize}`);
                break;  // data not enough for next Nalu
            }
            // Nalu with length-header (AVC1)
            let naluSize = v.getUint32(offset, !le);  // Big-Endian read
            if (lengthSize === 3) {
                naluSize >>>= 8;
            }
            if (naluSize > dataSize - lengthSize) {
                Log.w(this.TAG, `Malformed Nalus near timestamp ${dts}, NaluSize > DataSize!`);
                return;
            }

            let unitType = v.getUint8(offset + lengthSize) & 0x1F;

            if (unitType === 5) {  // IDR
                keyframe = true;
            }

            let data = new Uint8Array(arrayBuffer, dataOffset + offset, lengthSize + naluSize);
            let unit = {type: unitType, data: data};
            units.push(unit);
            length += data.byteLength;

            if (unitType === 6) {  // SEI
                this._parseSEIPayload(data.subarray(lengthSize), dts + cts, 'h264');
            }

            offset += lengthSize + naluSize;
        }

        if (units.length) {
            let track = this._videoTrack;
            let avcSample: FlvVideoSample = {
                units: units,
                length: length,
                isKeyframe: keyframe,
                dts: dts,
                cts: cts,
                pts: (dts + cts)
            };
            if (keyframe) {
                avcSample.fileposition = tagPosition;
            }
            track.samples.push(avcSample);
            track.length += length;
        }
    }

    _parseHEVCVideoData(arrayBuffer: ArrayBuffer, dataOffset: number, dataSize: number, tagTimestamp: number, tagPosition: number, frameType: number, cts: number): void {
        let le = this._littleEndian;
        let v = new DataView(arrayBuffer, dataOffset, dataSize);

        let units = [], length = 0;

        let offset = 0;
        const lengthSize = this._naluLengthSize;
        let dts = this._timestampBase + tagTimestamp;
        let keyframe = (frameType === 1);  // from FLV Frame Type constants

        while (offset < dataSize) {
            if (offset + 4 >= dataSize) {
                Log.w(this.TAG, `Malformed Nalu near timestamp ${dts}, offset = ${offset}, dataSize = ${dataSize}`);
                break;  // data not enough for next Nalu
            }
            // Nalu with length-header (HVC1)
            let naluSize = v.getUint32(offset, !le);  // Big-Endian read
            if (lengthSize === 3) {
                naluSize >>>= 8;
            }
            if (naluSize > dataSize - lengthSize) {
                Log.w(this.TAG, `Malformed Nalus near timestamp ${dts}, NaluSize > DataSize!`);
                return;
            }

            let unitType = (v.getUint8(offset + lengthSize) >> 1) & 0x3F;

            if (unitType === 19 || unitType === 20 || unitType === 21) {  // IRAP
                keyframe = true;
            }

            let data = new Uint8Array(arrayBuffer, dataOffset + offset, lengthSize + naluSize);
            let unit = {type: unitType, data: data};
            units.push(unit);
            length += data.byteLength;

            if (unitType === 39 || unitType === 40) {  // Prefix / Suffix SEI
                this._parseSEIPayload(data.subarray(lengthSize), dts + cts, 'h265');
            }

            offset += lengthSize + naluSize;
        }

        if (units.length) {
            let track = this._videoTrack;
            let hevcSample: FlvVideoSample = {
                units: units,
                length: length,
                isKeyframe: keyframe,
                dts: dts,
                cts: cts,
                pts: (dts + cts)
            };
            if (keyframe) {
                hevcSample.fileposition = tagPosition;
            }
            track.samples.push(hevcSample);
            track.length += length;
        }
    }

}

export default FLVDemuxer;