export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Test clock: fixed time that can be advanced. */
export class TestClock implements Clock {
  private t: number;
  constructor(start: Date | number = Date.now()) {
    this.t = typeof start === 'number' ? start : start.getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(d: Date | number) {
    this.t = typeof d === 'number' ? d : d.getTime();
  }
  advance(ms: number) {
    this.t += ms;
  }
}
