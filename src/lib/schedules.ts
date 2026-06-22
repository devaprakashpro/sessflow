import { nanoid } from 'nanoid';
import { db } from './db';
import type { Schedule } from './types';

export async function createSchedule(input: Omit<Schedule, 'id'>): Promise<Schedule> {
  const sched: Schedule = { ...input, id: nanoid(8) };
  await db.schedules.put(sched);
  return sched;
}

export async function updateSchedule(id: string, patch: Partial<Schedule>): Promise<void> {
  await db.schedules.update(id, patch);
}

export async function deleteSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

export function dayStamp(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Return schedules that are due to fire right now (within the current minute)
 * and have not already fired today. Pure function over a clock for testability.
 */
export function dueSchedules(all: Schedule[], now: Date): Schedule[] {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = dayStamp(now);
  const dow = now.getDay();
  return all.filter((s) => {
    if (!s.enabled) return false;
    if (s.lastFired === today) return false;
    if (s.days.length > 0 && !s.days.includes(dow)) return false;
    return s.time === hhmm;
  });
}
