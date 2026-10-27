/** 房间级事件扇出：写消息后唤醒挂起的 get_messages、网页轮询之外没有别的通道。 */

export class RoomHub {
  private waiters = new Map<string, Set<() => void>>();

  notify(room: string): void {
    const set = this.waiters.get(room);
    if (!set) return;
    for (const wake of [...set]) wake();
  }

  /** 等到有新消息或超时；返回 true 表示被唤醒。 */
  wait(room: string, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const set = this.waiters.get(room) ?? new Set<() => void>();
      this.waiters.set(room, set);
      let done = false;
      const finish = (notified: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        set.delete(waker);
        if (set.size === 0) this.waiters.delete(room);
        resolve(notified);
      };
      const waker = (): void => finish(true);
      const timer = setTimeout(() => finish(false), ms);
      set.add(waker);
    });
  }
}
