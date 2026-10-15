// Self-built pipeline (SPEC §7): Loader / Demuxer / Remuxer / Buffer / ABR / LiveController.
// DOM-free so it can run in a Worker. Interfaces land with the first implementation (M2 ABR,
// M3 FLV / TS / fMP4); until then HLS / DASH / FLV go through the engine adapters (SPEC §20).
export {};
