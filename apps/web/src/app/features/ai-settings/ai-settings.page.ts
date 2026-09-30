import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  AFTER_HOURS_ACTIONS,
  AI_DISCLOSURE,
  CRISIS_MESSAGE_MAX_LENGTH,
  EMERGENCY_MESSAGE_MAX_LENGTH,
  GREETING_MAX_LENGTH,
  MAX_INTERVALS_PER_DAY,
  TRANSFER_PURPOSES,
  URGENT_ACTIONS,
  URGENT_PHRASES_MAX_COUNT,
  validateBusinessHours,
  WEEKDAYS,
  type AfterHoursAction,
  type AiSettings,
  type BusinessHours,
  type TransferPurpose,
  type TransferTarget,
  type UpdateAiSettingsRequest,
  type UrgentAction,
  type Weekday,
} from '@frontdesk/shared';
import { firstValueFrom } from 'rxjs';
import { AiApi } from '../../core/api/ai-api';
import { errorMessage, errorMessages } from '../../core/api/api-error';
import { AuthService } from '../../core/auth/auth.service';
import { AFTER_HOURS_LABELS, TRANSFER_PURPOSE_LABELS, URGENT_ACTION_LABELS, WEEKDAY_LABELS } from '../../core/labels';

/** What the form edits. Phrases are one per line in the box. */
interface Draft {
  greeting: string;
  emergencyMessage: string;
  crisisMessage: string;
  afterHoursAction: AfterHoursAction;
  afterHoursTransferTargetId: string;
  urgentAction: UrgentAction;
  urgentTransferTargetId: string;
  extraUrgentPhrases: string;
  businessHours: BusinessHours;
}

const toDraft = (settings: AiSettings): Draft => ({
  greeting: settings.greeting,
  emergencyMessage: settings.emergencyMessage,
  crisisMessage: settings.crisisMessage,
  afterHoursAction: settings.afterHoursAction,
  afterHoursTransferTargetId: settings.afterHoursTransferTargetId ?? '',
  urgentAction: settings.urgentAction,
  urgentTransferTargetId: settings.urgentTransferTargetId ?? '',
  extraUrgentPhrases: settings.extraUrgentPhrases.join('\n'),
  businessHours: structuredClone(settings.businessHours),
});

const phrasesOf = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** How the practice's AI receptionist is set up: what it says, when, and what happens in an emergency. */
@Component({
  selector: 'app-ai-settings-page',
  templateUrl: './ai-settings.page.html',
  styleUrl: './ai-settings.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiSettingsPage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(AiApi);

  protected readonly weekdays = WEEKDAYS;
  protected readonly weekdayLabels = WEEKDAY_LABELS;
  protected readonly afterHoursActions = AFTER_HOURS_ACTIONS;
  protected readonly afterHoursLabels = AFTER_HOURS_LABELS;
  protected readonly urgentActions = URGENT_ACTIONS;
  protected readonly urgentLabels = URGENT_ACTION_LABELS;
  protected readonly purposes = TRANSFER_PURPOSES;
  protected readonly purposeLabels = TRANSFER_PURPOSE_LABELS;
  protected readonly disclosure = AI_DISCLOSURE;
  protected readonly limits = {
    greeting: GREETING_MAX_LENGTH,
    emergency: EMERGENCY_MESSAGE_MAX_LENGTH,
    crisis: CRISIS_MESSAGE_MAX_LENGTH,
    intervals: MAX_INTERVALS_PER_DAY,
    phrases: URGENT_PHRASES_MAX_COUNT,
  };

  protected readonly settings = signal<AiSettings | null>(null);
  protected readonly targets = signal<TransferTarget[]>([]);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);

  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly saveProblems = signal<string[]>([]);
  protected readonly switching = signal(false);
  protected readonly switchProblems = signal<string[]>([]);

  protected readonly newTarget = signal<{ label: string; phone: string; purpose: TransferPurpose }>({ label: '', phone: '', purpose: 'front_desk' });
  protected readonly addingTarget = signal(false);
  protected readonly targetProblem = signal<string | null>(null);

  protected readonly canEdit = computed(() => this.auth.can('ai:configure'));
  protected readonly activeTargets = computed(() => this.targets().filter((target) => target.active));

  /** The changes the person has made, in the shape the API takes; empty when nothing changed. */
  protected readonly changes = computed<UpdateAiSettingsRequest>(() => {
    const settings = this.settings();
    const draft = this.draft();
    if (!settings || !draft) return {};
    const saved = toDraft(settings);
    const changes: UpdateAiSettingsRequest = {};
    if (draft.greeting !== saved.greeting) changes.greeting = draft.greeting;
    if (draft.emergencyMessage !== saved.emergencyMessage) changes.emergencyMessage = draft.emergencyMessage;
    if (draft.crisisMessage !== saved.crisisMessage) changes.crisisMessage = draft.crisisMessage;
    if (draft.afterHoursAction !== saved.afterHoursAction) changes.afterHoursAction = draft.afterHoursAction;
    if (draft.afterHoursTransferTargetId !== saved.afterHoursTransferTargetId) changes.afterHoursTransferTargetId = draft.afterHoursTransferTargetId || null;
    if (draft.urgentAction !== saved.urgentAction) changes.urgentAction = draft.urgentAction;
    if (draft.urgentTransferTargetId !== saved.urgentTransferTargetId) changes.urgentTransferTargetId = draft.urgentTransferTargetId || null;
    if (JSON.stringify(phrasesOf(draft.extraUrgentPhrases)) !== JSON.stringify(settings.extraUrgentPhrases)) changes.extraUrgentPhrases = phrasesOf(draft.extraUrgentPhrases);
    if (JSON.stringify(draft.businessHours) !== JSON.stringify(saved.businessHours)) changes.businessHours = draft.businessHours;
    return changes;
  });
  protected readonly dirty = computed(() => Object.keys(this.changes()).length > 0);
  protected readonly hoursProblem = computed(() => {
    const draft = this.draft();
    return draft ? validateBusinessHours(draft.businessHours) : null;
  });
  protected readonly phraseProblem = computed(() => {
    const count = phrasesOf(this.draft()?.extraUrgentPhrases ?? '').length;
    return count > URGENT_PHRASES_MAX_COUNT ? `At most ${URGENT_PHRASES_MAX_COUNT} phrases.` : null;
  });
  protected readonly canSave = computed(() => this.canEdit() && this.dirty() && !this.saving() && !this.hoursProblem() && !this.phraseProblem());

  /** Bumped on every reload so a slow answer for a practice we have left is ignored. */
  private generation = 0;

  constructor() {
    toObservable(this.auth.practiceId)
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.load());
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  protected chooseAfterHours(event: Event): void {
    const chosen = AFTER_HOURS_ACTIONS.find((action) => action === this.value(event));
    if (chosen) this.set('afterHoursAction', chosen);
  }

  protected chooseUrgentAction(event: Event): void {
    const chosen = URGENT_ACTIONS.find((action) => action === this.value(event));
    if (chosen) this.set('urgentAction', chosen);
  }

  protected set<K extends keyof Draft>(field: K, value: Draft[K]): void {
    this.saved.set(false);
    this.draft.update((draft) => (draft ? { ...draft, [field]: value } : draft));
  }

  // ------------------------------------------------------------- hours

  protected setTime(day: Weekday, index: number, part: 'open' | 'close', value: string): void {
    this.editDay(day, (intervals) => intervals.map((interval, i) => (i === index ? { ...interval, [part]: value } : interval)));
  }

  protected addPeriod(day: Weekday): void {
    this.editDay(day, (intervals) => (intervals.length >= MAX_INTERVALS_PER_DAY ? intervals : [...intervals, { open: '09:00', close: '17:00' }]));
  }

  protected removePeriod(day: Weekday, index: number): void {
    this.editDay(day, (intervals) => intervals.filter((_, i) => i !== index));
  }

  protected openAllDay(day: Weekday): void {
    this.editDay(day, () => [{ open: '00:00', close: '24:00' }]);
  }

  private editDay(day: Weekday, edit: (intervals: BusinessHours[Weekday]) => BusinessHours[Weekday]): void {
    const draft = this.draft();
    if (!draft) return;
    this.set('businessHours', { ...draft.businessHours, [day]: edit(draft.businessHours[day]) });
  }

  // -------------------------------------------------------------- save

  protected async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.saved.set(false);
    this.saveProblems.set([]);
    const generation = this.generation;
    try {
      const updated = await firstValueFrom(this.api.updateSettings(this.changes()));
      if (generation !== this.generation) return;
      this.settings.set(updated);
      this.draft.set(toDraft(updated));
      this.saved.set(true);
    } catch (error) {
      if (generation === this.generation) this.saveProblems.set(errorMessages(error));
    } finally {
      if (generation === this.generation) this.saving.set(false);
    }
  }

  /** Turning the AI on or off. Kept separate from saving so nothing is switched on by accident. */
  protected async toggleEnabled(): Promise<void> {
    const settings = this.settings();
    if (!settings || !this.canEdit() || this.dirty() || this.switching()) return;
    this.switching.set(true);
    this.switchProblems.set([]);
    const generation = this.generation;
    try {
      const updated = await firstValueFrom(this.api.updateSettings({ enabled: !settings.enabled }));
      if (generation !== this.generation) return;
      this.settings.set(updated);
    } catch (error) {
      if (generation === this.generation) this.switchProblems.set(errorMessages(error));
    } finally {
      if (generation === this.generation) this.switching.set(false);
    }
  }

  // ----------------------------------------------------- transfer numbers

  protected setNewTarget(field: 'label' | 'phone' | 'purpose', value: string): void {
    this.newTarget.update((target) => ({ ...target, [field]: value }));
  }

  protected async addTarget(): Promise<void> {
    const target = this.newTarget();
    if (!this.canEdit() || this.addingTarget() || target.label.trim() === '' || target.phone.trim() === '') return;
    this.addingTarget.set(true);
    this.targetProblem.set(null);
    const generation = this.generation;
    try {
      const created = await firstValueFrom(this.api.createTransferTarget({ label: target.label.trim(), phone: target.phone.trim(), purpose: target.purpose }));
      if (generation !== this.generation) return;
      this.targets.update((list) => [...list, created]);
      this.newTarget.set({ label: '', phone: '', purpose: 'front_desk' });
    } catch (error) {
      if (generation === this.generation) this.targetProblem.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.addingTarget.set(false);
    }
  }

  protected async setTargetActive(target: TransferTarget, active: boolean): Promise<void> {
    if (!this.canEdit()) return;
    this.targetProblem.set(null);
    const generation = this.generation;
    try {
      const updated = await firstValueFrom(this.api.updateTransferTarget(target.id, { active }));
      if (generation !== this.generation) return;
      this.targets.update((list) => list.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      if (generation === this.generation) this.targetProblem.set(errorMessage(error));
    }
  }

  // -------------------------------------------------------------- load

  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.loadError.set(null);
    this.settings.set(null);
    this.draft.set(null);
    this.targets.set([]);
    this.saveProblems.set([]);
    this.switchProblems.set([]);
    this.saved.set(false);
    try {
      const [settings, targets] = await Promise.all([firstValueFrom(this.api.settings()), firstValueFrom(this.api.transferTargets())]);
      if (generation !== this.generation) return;
      this.settings.set(settings);
      this.draft.set(toDraft(settings));
      this.targets.set(targets);
    } catch (error) {
      if (generation === this.generation) this.loadError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
