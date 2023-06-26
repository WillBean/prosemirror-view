export enum SchedulePriority {
  Low = 'Low', // 低优先级，idle 执行
  High = 'High', // 高优先级，raf 执行
}

export interface IScheduleTask {
  priority: SchedulePriority;
  callback(): void;
}

export class Schedule {
  private lowQueen: IScheduleTask[] = [];
  private highQueen: IScheduleTask[] = [];
  private scheduling = false;

  addTask(task: IScheduleTask) {
    if (task.priority === SchedulePriority.Low) {
      this.lowQueen.push(task);
    } else {
      this.highQueen.push(task);
    }

    this.start();
  }

  private start() {
    if (this.lowQueen.length) this.scheduleLowPriorityTasks();
    if (this.highQueen.length) this.scheduleHighPriorityTasks();
  }

  private scheduleHighPriorityTasks() {
    if (this.scheduling) return;
    requestAnimationFrame(() => {
      this.highQueen.forEach(task => task.callback());
      this.highQueen = [];
      this.scheduling = false;
    });
    this.scheduling = true;
  }

  private scheduleLowPriorityTasks() {
    const task = this.lowQueen.shift();
    task && requestIdleCallback(() => {
      task.callback();
      this.scheduleLowPriorityTasks();
    });
  }
}

function ownerRequestIdleCallback(cb: Function) {
  const start = Date.now();
  return setTimeout(() => {
    cb({
      didTimeout: false,
      timeRemaining() {
        return Math.max(0, 50 - (Date.now() - start));
      }
    });
  }, 1);
}

// function ownerCancelIdleCallback(id: number) {
//   clearTimeout(id);
// }

const requestIdleCallback = window.requestIdleCallback || ownerRequestIdleCallback;
// const cancelIdleCallback = window.cancelIdleCallback || ownerCancelIdleCallback;

export default new Schedule();
