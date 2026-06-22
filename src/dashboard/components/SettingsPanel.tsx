import { useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../../lib/settings';
import { currentUser, signIn, signOut, signUp, syncNow } from '../../lib/sync';
import { meshHealth } from '../../lib/mesh';
import type { Settings } from '../../lib/types';

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [user, setUser] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    getSettings().then(setS);
    currentUser().then((u) => setUser(u?.email ?? null)).catch(() => {});
  }, []);

  if (!s) return null;
  const patch = (p: Partial<Settings>) => setS((prev) => ({ ...prev!, ...p }));
  const patchSync = (p: Partial<Settings['sync']>) => setS((prev) => ({ ...prev!, sync: { ...prev!.sync, ...p } }));

  async function persist() {
    await saveSettings(s!);
    setMsg('Saved ✓');
    setTimeout(() => setMsg(''), 1500);
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-vault-panel border-l border-vault-border p-5 space-y-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>

        <Section title="Auto-save & crash recovery">
          <Toggle label="Auto-save all windows periodically" checked={s.autoSave} onChange={(v) => patch({ autoSave: v })} />
          <Num label="Auto-save interval (min)" value={s.autoSaveIntervalMin} onChange={(v) => patch({ autoSaveIntervalMin: v })} />
          <Toggle label="Auto-save a window when it's closed" checked={s.autoSaveOnClose} onChange={(v) => patch({ autoSaveOnClose: v })} />
          <Num label="Crash snapshots to keep" value={s.crashSnapshots} onChange={(v) => patch({ crashSnapshots: v })} />
          <Num label="Crash snapshot interval (min)" value={s.crashSnapshotIntervalMin} onChange={(v) => patch({ crashSnapshotIntervalMin: v })} />
        </Section>

        <Section title="AI auto-grouping (Claude)">
          <Toggle label="Enable AI grouping" checked={s.aiEnabled} onChange={(v) => patch({ aiEnabled: v })} />
          <Field label="Anthropic API key">
            <input className="input" type="password" placeholder="sk-ant-…" value={s.anthropicApiKey ?? ''} onChange={(e) => patch({ anthropicApiKey: e.target.value })} />
          </Field>
          <Field label="Model">
            <select className="input" value={s.aiModel} onChange={(e) => patch({ aiModel: e.target.value })}>
              <option value="claude-opus-4-8">claude-opus-4-8 (best)</option>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6 (balanced)</option>
              <option value="claude-haiku-4-5-20251001">claude-haiku-4-5 (fast/cheap)</option>
            </select>
          </Field>
          <p className="text-xs text-vault-muted">Key is stored locally and sent only to api.anthropic.com.</p>
        </Section>

        <Section title="Tab suspension (memory saver)">
          <Toggle label="Suspend idle background tabs" checked={s.suspendEnabled} onChange={(v) => patch({ suspendEnabled: v })} />
          <Num label="Suspend after idle (min)" value={s.suspendAfterMin} onChange={(v) => patch({ suspendAfterMin: v })} />
          <Field label="Never suspend domains (comma-separated)">
            <input className="input" value={s.suspendNeverDomains.join(', ')} onChange={(e) => patch({ suspendNeverDomains: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="mail.google.com, figma.com" />
          </Field>
        </Section>

        <Section title="Cloud sync">
          <Field label="Provider">
            <select className="input" value={s.sync.provider} onChange={(e) => patchSync({ provider: e.target.value as any })}>
              <option value="none">None (local only)</option>
              <option value="mesh">Mesh (self-host · Tailscale)</option>
              <option value="supabase">Supabase</option>
            </select>
          </Field>
          {s.sync.provider === 'mesh' && (
            <>
              <Field label="Mesh server URL"><input className="input" value={s.sync.meshUrl ?? ''} onChange={(e) => patchSync({ meshUrl: e.target.value })} placeholder="http://your-laptop.tailnet.ts.net:7777" /></Field>
              <Field label="Device token"><input className="input" type="password" value={s.sync.meshToken ?? ''} onChange={(e) => patchSync({ meshToken: e.target.value })} placeholder="printed by the server on first start" /></Field>
              <Toggle label="Auto-sync every 5 min" checked={s.sync.autoSync} onChange={(v) => patchSync({ autoSync: v })} />
              <div className="flex gap-2">
                <button className="btn-ghost border border-vault-border" onClick={async () => { await saveSettings(s); const h = await meshHealth(); setMsg(h.ok ? `Connected ✓ (AI ${h.ai ? 'on' : 'off'})` : 'Cannot reach server'); }}>Test connection</button>
                <button className="btn-ghost border border-vault-border flex-1 justify-center" onClick={async () => { await saveSettings(s); const r = await syncNow(); setMsg(r.ok ? `Synced ↑${r.pushed} ↓${r.pulled}` : r.error ?? 'Sync failed'); }}>Sync now</button>
              </div>
              <p className="text-xs text-vault-muted">Your sessions sync to your own machine over Tailscale. The server also archives pages and powers AI search.</p>
            </>
          )}
          {s.sync.provider === 'supabase' && (
            <>
              <Field label="Supabase URL"><input className="input" value={s.sync.supabaseUrl ?? ''} onChange={(e) => patchSync({ supabaseUrl: e.target.value })} placeholder="https://xxxx.supabase.co" /></Field>
              <Field label="Anon key"><input className="input" type="password" value={s.sync.supabaseAnonKey ?? ''} onChange={(e) => patchSync({ supabaseAnonKey: e.target.value })} /></Field>
              <Field label="E2E passphrase (optional — encrypts before upload)"><input className="input" type="password" value={s.sync.e2ePassphrase ?? ''} onChange={(e) => patchSync({ e2ePassphrase: e.target.value })} /></Field>
              <Toggle label="Auto-sync every 5 min" checked={s.sync.autoSync} onChange={(v) => patchSync({ autoSync: v })} />

              <div className="card p-3 space-y-2">
                <div className="text-xs text-vault-muted">{user ? `Signed in as ${user}` : 'Not signed in'}</div>
                {!user ? (
                  <div className="space-y-2">
                    <input className="input" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                    <input className="input" type="password" placeholder="password" value={pw} onChange={(e) => setPw(e.target.value)} />
                    <div className="flex gap-2">
                      <button className="btn-primary" onClick={async () => { await saveSettings(s); const { error } = await signIn(email, pw); setMsg(error ? error.message : 'Signed in ✓'); if (!error) setUser(email); }}>Sign in</button>
                      <button className="btn-ghost border border-vault-border" onClick={async () => { await saveSettings(s); const { error } = await signUp(email, pw); setMsg(error ? error.message : 'Check your email ✓'); }}>Sign up</button>
                    </div>
                  </div>
                ) : (
                  <button className="btn-ghost border border-vault-border" onClick={async () => { await signOut(); setUser(null); }}>Sign out</button>
                )}
                <button className="btn-ghost border border-vault-border w-full justify-center" onClick={async () => { await saveSettings(s); const r = await syncNow(); setMsg(r.ok ? `Synced ↑${r.pushed} ↓${r.pulled}` : r.error ?? 'Sync failed'); }}>Sync now</button>
              </div>
            </>
          )}
        </Section>

        <div className="sticky bottom-0 -mx-5 bg-vault-panel/95 border-t border-vault-border px-5 py-3 flex items-center justify-between">
          <span className="text-xs text-vault-accent2">{msg}</span>
          <button className="btn-primary" onClick={persist}>Save settings</button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      {children}
    </section>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1"><span className="text-xs text-vault-muted">{label}</span>{children}</label>;
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer">
      <span className="text-sm text-white">{label}</span>
      <button type="button" onClick={() => onChange(!checked)} className={`h-5 w-9 rounded-full transition-colors ${checked ? 'bg-vault-accent' : 'bg-vault-border'} relative shrink-0`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </label>
  );
}
function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return <Field label={label}><input className="input" type="number" min={1} value={value} onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 1))} /></Field>;
}
