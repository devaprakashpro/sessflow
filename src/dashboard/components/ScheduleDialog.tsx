import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../lib/db';
import { createSchedule, deleteSchedule, updateSchedule } from '../../lib/schedules';
import type { Session } from '../../lib/types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Set up automatic opening of a session at a time on chosen weekdays. */
export function ScheduleDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const existing = useLiveQuery(() => db.schedules.where('sessionId').equals(session.id).toArray(), [session.id], []);
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [newWindow, setNewWindow] = useState(true);

  useEffect(() => {
    if (existing && existing[0]) {
      setTime(existing[0].time);
      setDays(existing[0].days);
      setNewWindow(existing[0].newWindow);
    }
  }, [existing]);

  const toggleDay = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));

  async function save() {
    if (existing && existing[0]) {
      await updateSchedule(existing[0].id, { time, days, newWindow, enabled: true });
    } else {
      await createSchedule({ name: session.name, sessionId: session.id, time, days, newWindow, enabled: true });
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="card w-full max-w-sm p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Schedule “{session.name}”</h3>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-vault-muted">Open at</span>
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>

        <div className="space-y-1">
          <span className="text-xs text-vault-muted">On days (none = every day)</span>
          <div className="flex gap-1">
            {DAYS.map((d, i) => (
              <button key={d} onClick={() => toggleDay(i)} className={`flex-1 rounded-md py-1.5 text-xs ${days.includes(i) ? 'bg-vault-accent text-white' : 'bg-vault-panel text-vault-muted'}`}>
                {d}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={newWindow} onChange={(e) => setNewWindow(e.target.checked)} />
          Open in a new window
        </label>

        <div className="flex items-center justify-between pt-2">
          {existing && existing[0] ? (
            <button className="btn-ghost text-red-400" onClick={() => { deleteSchedule(existing[0].id); onClose(); }}>Remove schedule</button>
          ) : <span />}
          <button className="btn-primary" onClick={save}>Save schedule</button>
        </div>
      </div>
    </div>
  );
}
