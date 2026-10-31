/**
 * Registry of in-flight download streams so access revocation/expiry can terminate them promptly.
 * Each stream registers a predicate-free record; the server rechecks authorisation on a timer and on
 * Postgres NOTIFY, and calls kill() for streams that are no longer authorised.
 */
export interface ActiveStream {
  id: string;
  transferId: string;
  grantId: string;
  recipientSessionId: string;
  startedAt: Date;
  kill: (reason: string) => void;
}

export class ActiveStreams {
  private streams = new Map<string, ActiveStream>();

  add(s: ActiveStream) {
    this.streams.set(s.id, s);
  }
  remove(id: string) {
    this.streams.delete(id);
  }
  list(): ActiveStream[] {
    return [...this.streams.values()];
  }
  killMatching(pred: (s: ActiveStream) => boolean, reason: string): number {
    let n = 0;
    for (const s of this.streams.values()) {
      if (pred(s)) {
        s.kill(reason);
        this.streams.delete(s.id);
        n++;
      }
    }
    return n;
  }
  get size() {
    return this.streams.size;
  }
}
