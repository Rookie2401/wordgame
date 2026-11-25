import { useState } from 'react';
import type { GameMode, ScoringMode, Snapshot, WinType } from '../backend/types';
import { ROTATION_CHOICES, TARGET_CHOICES } from '../game/logic';

export interface Rules {
  mode: GameMode;
  scoring: ScoringMode;
  winType: WinType;
  target: number;
  rotations: number;
}

export const DEFAULT_RULES: Rules = { mode: 'digital', scoring: 'digital', winType: 'target', target: 25, rotations: 2 };

export function rulesFromRoom(room: Snapshot['room']): Rules {
  return {
    mode: room.mode,
    scoring: room.scoring,
    winType: room.win_type,
    target: room.target_score ?? 25,
    rotations: room.rotation_limit ?? 2,
  };
}

/** Arguments for create_room / update_settings. */
export function rulesArgs(r: Rules) {
  const winType = r.scoring === 'traditional' && r.winType === 'target' ? 'unlimited' : r.winType;
  return {
    p_mode: r.mode,
    p_scoring: r.scoring,
    p_win_type: winType,
    p_target: winType === 'target' ? r.target : null,
    p_rotations: winType === 'rotations' ? r.rotations : null,
  };
}

export function validateRules(r: Rules): string | null {
  if (r.scoring === 'digital' && r.winType === 'target' && !(r.target >= 5 && r.target <= 1000)) {
    return 'Choose a target between 5 and 1000 points.';
  }
  if (r.winType === 'rotations' && !(r.rotations >= 1 && r.rotations <= 50)) {
    return 'Choose between 1 and 50 rotations.';
  }
  return null;
}

function Option(props: { name: string; checked: boolean; onChange(): void; title: string; hint: string }) {
  return (
    <label className={`option ${props.checked ? 'option-on' : ''}`}>
      <input type="radio" name={props.name} checked={props.checked} onChange={props.onChange} />
      <span>
        <strong>{props.title}</strong>
        <small>{props.hint}</small>
      </span>
    </label>
  );
}

/** The game options, shared by the Create screen and the lobby. */
export function RulesFields({ value, onChange }: { value: Rules; onChange(r: Rules): void }) {
  const set = (patch: Partial<Rules>) => onChange({ ...value, ...patch });
  const [customTarget, setCustomTarget] = useState(!TARGET_CHOICES.includes(value.target));
  const [customRotations, setCustomRotations] = useState(!ROTATION_CHOICES.includes(value.rotations));
  const digital = value.scoring === 'digital';
  const winType = !digital && value.winType === 'target' ? 'unlimited' : value.winType;

  return (
    <>
      <fieldset className="field choice">
        <legend className="label">Cards</legend>
        <Option
          name="mode"
          checked={value.mode === 'digital'}
          onChange={() => set({ mode: 'digital' })}
          title="Digital cards"
          hint="The app deals an unusual word each round."
        />
        <Option
          name="mode"
          checked={value.mode === 'physical'}
          onChange={() => set({ mode: 'physical' })}
          title="Physical cards"
          hint="The reader types in a card from the box."
        />
      </fieldset>

      <fieldset className="field choice">
        <legend className="label">Voting and scores</legend>
        <Option
          name="scoring"
          checked={digital}
          onChange={() => set({ scoring: 'digital' })}
          title="Vote and score in the app"
          hint="Private ballots on each phone; points are kept for you."
        />
        <Option
          name="scoring"
          checked={!digital}
          onChange={() => set({ scoring: 'traditional' })}
          title="Traditional"
          hint="Vote aloud and keep score on paper."
        />
      </fieldset>

      <label className="field">
        <span className="label">The game ends</span>
        <select
          className="input"
          value={winType}
          onChange={(e) => set({ winType: e.target.value as WinType })}
          data-testid="win-type"
        >
          {digital && <option value="target">when someone reaches a target score</option>}
          <option value="rotations">after a set number of turns as reader</option>
          <option value="unlimited">when the host ends it</option>
        </select>
      </label>

      {digital && winType === 'target' && (
        <label className="field">
          <span className="label">Target score</span>
          <select
            className="input"
            value={customTarget ? 'custom' : String(value.target)}
            data-testid="target"
            onChange={(e) => {
              if (e.target.value === 'custom') setCustomTarget(true);
              else {
                setCustomTarget(false);
                set({ target: Number(e.target.value) });
              }
            }}
          >
            {TARGET_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} points
              </option>
            ))}
            <option value="custom">Another number…</option>
          </select>
          {customTarget && (
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={5}
              max={1000}
              aria-label="Custom target score"
              value={Number.isFinite(value.target) ? value.target : ''}
              onChange={(e) => set({ target: e.target.valueAsNumber })}
            />
          )}
          <small className="hint">Once someone reaches it, the round of readers is finished so everyone has had a turn.</small>
        </label>
      )}

      {winType === 'rotations' && (
        <label className="field">
          <span className="label">Turns as reader, each</span>
          <select
            className="input"
            value={customRotations ? 'custom' : String(value.rotations)}
            data-testid="rotations"
            onChange={(e) => {
              if (e.target.value === 'custom') setCustomRotations(true);
              else {
                setCustomRotations(false);
                set({ rotations: Number(e.target.value) });
              }
            }}
          >
            {ROTATION_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n === 1 ? 'One' : n === 2 ? 'Two' : n === 3 ? 'Three' : 'Five'}
              </option>
            ))}
            <option value="custom">Another number…</option>
          </select>
          {customRotations && (
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={1}
              max={50}
              aria-label="Custom number of rotations"
              value={Number.isFinite(value.rotations) ? value.rotations : ''}
              onChange={(e) => set({ rotations: e.target.valueAsNumber })}
            />
          )}
        </label>
      )}
    </>
  );
}
