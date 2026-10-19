// Derived from hls.js@e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de src/utils/output-filter.ts, Apache-2.0
import type { CaptionScreen } from './cea-608-parser.js';

/** What OutputFilter needs from hls.js' TimelineController (Otter: the CEA-608 decoder). */
export interface CaptionsSink {
  addCues(trackName: string, startTime: number, endTime: number, screen: CaptionScreen, cueRanges: Array<[number, number]>): void;
  createCaptionsTrack(trackName: string): void;
}

export default class OutputFilter {
  private timelineController: CaptionsSink;
  private cueRanges: Array<[number, number]> = [];
  private trackName: string;
  private startTime: number | null = null;
  private endTime: number | null = null;
  private screen: CaptionScreen | null = null;

  constructor(timelineController: CaptionsSink, trackName: string) {
    this.timelineController = timelineController;
    this.trackName = trackName;
  }

  dispatchCue(): void {
    if (this.startTime === null) {
      return;
    }

    this.timelineController.addCues(
      this.trackName,
      this.startTime,
      this.endTime as number,
      this.screen as CaptionScreen,
      this.cueRanges,
    );
    this.startTime = null;
  }

  newCue(startTime: number, endTime: number, screen: CaptionScreen): void {
    if (this.startTime === null || this.startTime > startTime) {
      this.startTime = startTime;
    }

    this.endTime = endTime;
    this.screen = screen;
    this.timelineController.createCaptionsTrack(this.trackName);
  }

  reset(): void {
    this.cueRanges = [];
    this.startTime = null;
  }
}
