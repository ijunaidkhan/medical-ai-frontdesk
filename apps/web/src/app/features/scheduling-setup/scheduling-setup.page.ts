import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  APPOINTMENT_DURATION_MAX,
  APPOINTMENT_DURATION_MIN,
  APPOINTMENT_TYPE_NAME_MAX_LENGTH,
  CANCEL_MIN_HOURS_MAX,
  emptyBusinessHours,
  IDENTITY_FAILURE_CAP_MAX,
  IDENTITY_FAILURE_CAP_MIN,
  MAX_ADVANCE_DAYS_MAX,
  MIN_NOTICE_HOURS_MAX,
  PROVIDER_NAME_MAX_LENGTH,
  PROVIDER_TITLE_MAX_LENGTH,
  SLOT_MINUTES_OPTIONS,
  TIME_FORMATS,
  TIME_OFF_REASON_MAX_LENGTH,
  validateBusinessHours,
  type AppointmentType,
  type BusinessHours,
  type Provider,
  type ProviderTimeOff,
  type SchedulingSettings,
  type SlotMinutes,
  type TimeFormat,
  type UpdateAppointmentTypeRequest,
  type UpdateProviderRequest,
  type UpdateSchedulingSettingsRequest,
} from '@frontdesk/shared';
import { firstValueFrom } from 'rxjs';
import { errorMessage, errorMessages } from '../../core/api/api-error';
import { SchedulingApi } from '../../core/api/scheduling-api';
import { AuthService } from '../../core/auth/auth.service';
import { formatWhen, todayIn, zonedInstant } from '../../core/zoned-time';
import { HoursEditorComponent } from '../../shared/hours-editor/hours-editor.component';

/** The booking rules as typed: numbers stay text until they are checked. */
interface RulesDraft {
  slotMinutes: string;
  minNoticeHours: string;
  maxAdvanceDays: string;
  cancelMinHours: string;
  timeFormat: TimeFormat;
  identityFailureCapPerHour: string;
}

interface ProviderDraft {
  /** null while adding a new provider. */
  id: string | null;
  name: string;
  title: string;
  hours: BusinessHours;
  appointmentTypeIds: string[];
}

interface TypeDraft {
  id: string | null;
  name: string;
  durationMinutes: string;
  providerIds: string[];
}

interface TimeOffDraft {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  reason: string;
}

const RULE_LIMITS: Record<'minNoticeHours' | 'maxAdvanceDays' | 'cancelMinHours' | 'identityFailureCapPerHour', { min: number; max: number; label: string }> = {
  minNoticeHours: { min: 0, max: MIN_NOTICE_HOURS_MAX, label: 'Minimum notice' },
  maxAdvanceDays: { min: 1, max: MAX_ADVANCE_DAYS_MAX, label: 'How far ahead' },
  cancelMinHours: { min: 0, max: CANCEL_MIN_HOURS_MAX, label: 'Cancellation window' },
  identityFailureCapPerHour: { min: IDENTITY_FAILURE_CAP_MIN, max: IDENTITY_FAILURE_CAP_MAX, label: 'Failed identity checks per hour' },
};

const toRulesDraft = (settings: SchedulingSettings): RulesDraft => ({
  slotMinutes: String(settings.slotMinutes),
  minNoticeHours: String(settings.minNoticeHours),
  maxAdvanceDays: String(settings.maxAdvanceDays),
  cancelMinHours: String(settings.cancelMinHours),
  timeFormat: settings.timeFormat,
  identityFailureCapPerHour: String(settings.identityFailureCapPerHour),
});

/** A whole number written in plain digits, or null. */
const wholeNumber = (text: string): number | null => (/^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : null);

const sameList = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * Who can be booked, for what, and when: the practice's booking rules, its providers with their
 * weekly hours and days off, and the kinds of visit. Owners and administrators change it; staff
 * can look. Everything is checked again by the API.
 */
@Component({
  selector: 'app-scheduling-setup-page',
  imports: [HoursEditorComponent],
  templateUrl: './scheduling-setup.page.html',
  styleUrl: './scheduling-setup.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SchedulingSetupPage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(SchedulingApi);

  protected readonly slotOptions = SLOT_MINUTES_OPTIONS;
  protected readonly timeFormats = TIME_FORMATS;
  protected readonly limits = {
    providerName: PROVIDER_NAME_MAX_LENGTH,
    providerTitle: PROVIDER_TITLE_MAX_LENGTH,
    typeName: APPOINTMENT_TYPE_NAME_MAX_LENGTH,
    durationMin: APPOINTMENT_DURATION_MIN,
    durationMax: APPOINTMENT_DURATION_MAX,
    reason: TIME_OFF_REASON_MAX_LENGTH,
    rules: RULE_LIMITS,
  };

  protected readonly canEdit = computed(() => this.auth.can('schedule:configure'));
  protected readonly timeZone = computed(() => this.auth.practice()?.timezone ?? 'UTC');

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly settings = signal<SchedulingSettings | null>(null);
  protected readonly providers = signal<Provider[]>([]);
  protected readonly types = signal<AppointmentType[]>([]);

  // ------------------------------------------------------------ rules state

  protected readonly rules = signal<RulesDraft | null>(null);
  protected readonly savingRules = signal(false);
  protected readonly rulesSaved = signal(false);
  protected readonly rulesErrors = signal<string[]>([]);
  protected readonly switching = signal(false);
  protected readonly switchProblems = signal<string[]>([]);

  /** What is wrong with the typed rules, if anything (checked here for quick feedback; the API checks again). */
  protected readonly rulesProblems = computed<string[]>(() => {
    const draft = this.rules();
    if (!draft) return [];
    const problems: string[] = [];
    for (const [key, limit] of Object.entries(RULE_LIMITS) as Array<[keyof typeof RULE_LIMITS, (typeof RULE_LIMITS)[keyof typeof RULE_LIMITS]]>) {
      const value = wholeNumber(draft[key]);
      if (value === null || value < limit.min || value > limit.max) problems.push(`${limit.label} must be a whole number from ${limit.min} to ${limit.max}.`);
    }
    return problems;
  });

  /** Only the rules that changed, in the shape the API takes. */
  protected readonly rulesChanges = computed<UpdateSchedulingSettingsRequest>(() => {
    const settings = this.settings();
    const draft = this.rules();
    if (!settings || !draft || this.rulesProblems().length > 0) return {};
    const changes: UpdateSchedulingSettingsRequest = {};
    const slot = Number(draft.slotMinutes) as SlotMinutes;
    if (slot !== settings.slotMinutes) changes.slotMinutes = slot;
    for (const key of ['minNoticeHours', 'maxAdvanceDays', 'cancelMinHours', 'identityFailureCapPerHour'] as const) {
      const value = Number(draft[key]);
      if (value !== settings[key]) changes[key] = value;
    }
    if (draft.timeFormat !== settings.timeFormat) changes.timeFormat = draft.timeFormat;
    return changes;
  });
  protected readonly rulesDirty = computed(() => {
    const settings = this.settings();
    const draft = this.rules();
    return !!settings && !!draft && JSON.stringify(draft) !== JSON.stringify(toRulesDraft(settings));
  });
  protected readonly canSaveRules = computed(
    () => this.canEdit() && this.rulesDirty() && this.rulesProblems().length === 0 && Object.keys(this.rulesChanges()).length > 0 && !this.savingRules(),
  );

  // --------------------------------------------------------- editors state

  protected readonly providerDraft = signal<ProviderDraft | null>(null);
  protected readonly typeDraft = signal<TypeDraft | null>(null);
  protected readonly editorErrors = signal<string[]>([]);
  protected readonly savingEditor = signal(false);
  /** Said when someone tries to open another editor while one has unsaved changes. */
  protected readonly editorNotice = signal<string | null>(null);
  protected readonly listError = signal<string | null>(null);

  protected readonly providerProblems = computed<string[]>(() => {
    const draft = this.providerDraft();
    if (!draft) return [];
    const problems: string[] = [];
    if (draft.name.trim() === '') problems.push('Write the provider’s name.');
    const hours = validateBusinessHours(draft.hours);
    if (hours) problems.push(hours);
    return problems;
  });

  protected readonly typeProblems = computed<string[]>(() => {
    const draft = this.typeDraft();
    if (!draft) return [];
    const problems: string[] = [];
    if (draft.name.trim() === '') problems.push('Write a name for this kind of visit.');
    const minutes = wholeNumber(draft.durationMinutes);
    if (minutes === null || minutes < APPOINTMENT_DURATION_MIN || minutes > APPOINTMENT_DURATION_MAX) {
      problems.push(`The length must be a whole number of minutes from ${APPOINTMENT_DURATION_MIN} to ${APPOINTMENT_DURATION_MAX}.`);
    }
    return problems;
  });

  private readonly providerChanges = computed<UpdateProviderRequest>(() => {
    const draft = this.providerDraft();
    const original = draft?.id ? this.providers().find((provider) => provider.id === draft.id) : undefined;
    if (!draft || !original) return {};
    const changes: UpdateProviderRequest = {};
    if (draft.name.trim() !== original.name) changes.name = draft.name.trim();
    if (draft.title.trim() !== original.title) changes.title = draft.title.trim();
    if (JSON.stringify(draft.hours) !== JSON.stringify(original.hours)) changes.hours = draft.hours;
    if (!sameList(draft.appointmentTypeIds, original.appointmentTypeIds)) changes.appointmentTypeIds = draft.appointmentTypeIds;
    return changes;
  });

  private readonly typeChanges = computed<UpdateAppointmentTypeRequest>(() => {
    const draft = this.typeDraft();
    const original = draft?.id ? this.types().find((type) => type.id === draft.id) : undefined;
    if (!draft || !original) return {};
    const changes: UpdateAppointmentTypeRequest = {};
    if (draft.name.trim() !== original.name) changes.name = draft.name.trim();
    if (Number(draft.durationMinutes) !== original.durationMinutes) changes.durationMinutes = Number(draft.durationMinutes);
    if (!sameList(draft.providerIds, original.providerIds)) changes.providerIds = draft.providerIds;
    return changes;
  });

  /** Whether the open editor holds anything not yet saved. */
  protected readonly editorDirty = computed(() => {
    const provider = this.providerDraft();
    if (provider) return provider.id === null ? provider.name.trim() !== '' : Object.keys(this.providerChanges()).length > 0;
    const type = this.typeDraft();
    if (type) return type.id === null ? type.name.trim() !== '' : Object.keys(this.typeChanges()).length > 0;
    return false;
  });

  // ------------------------------------------------------------ days off

  protected readonly timeOffProvider = signal<Provider | null>(null);
  protected readonly timeOffList = signal<ProviderTimeOff[]>([]);
  protected readonly timeOffLoading = signal(false);
  protected readonly timeOffDraft = signal<TimeOffDraft>({ startDate: '', startTime: '00:00', endDate: '', endTime: '23:59', reason: '' });
  protected readonly timeOffError = signal<string | null>(null);
  protected readonly savingTimeOff = signal(false);

  /** The start and end the person typed, as instants on the practice's clock, or what is wrong with them. */
  protected readonly timeOffRange = computed<{ startsAt: Date; endsAt: Date } | { problem: string }>(() => {
    const draft = this.timeOffDraft();
    const startsAt = zonedInstant(draft.startDate, draft.startTime, this.timeZone());
    const endsAt = zonedInstant(draft.endDate, draft.endTime, this.timeZone());
    if (!startsAt || !endsAt) return { problem: 'Choose a start and an end (dates, and times such as 09:00).' };
    if (endsAt.getTime() <= startsAt.getTime()) return { problem: 'The end must be after the start.' };
    return { startsAt, endsAt };
  });

  protected readonly timeOffProblem = computed(() => {
    const range = this.timeOffRange();
    return 'problem' in range ? range.problem : null;
  });

  /** Bumped on every reload so a slow answer for a practice we have left is ignored. */
  private generation = 0;

  constructor() {
    toObservable(this.auth.practiceId)
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.load());
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected typeName(id: string): string {
    return this.types().find((type) => type.id === id)?.name ?? '';
  }

  protected providerName(id: string): string {
    return this.providers().find((provider) => provider.id === id)?.name ?? '';
  }

  protected when(iso: string): string {
    return formatWhen(iso, this.timeZone(), this.settings()?.timeFormat ?? '12h');
  }

  // ------------------------------------------------------------- rules

  protected setRule<K extends keyof RulesDraft>(field: K, value: RulesDraft[K]): void {
    this.rulesSaved.set(false);
    this.rules.update((draft) => (draft ? { ...draft, [field]: value } : draft));
  }

  protected chooseTimeFormat(event: Event): void {
    const chosen = TIME_FORMATS.find((format) => format === this.value(event));
    if (chosen) this.setRule('timeFormat', chosen);
  }

  protected async saveRules(): Promise<void> {
    if (!this.canSaveRules()) return;
    this.savingRules.set(true);
    this.rulesErrors.set([]);
    const generation = this.generation;
    try {
      const updated = await firstValueFrom(this.api.updateSettings(this.rulesChanges()));
      if (generation !== this.generation) return;
      this.settings.set(updated);
      this.rules.set(toRulesDraft(updated));
      this.rulesSaved.set(true);
    } catch (error) {
      if (generation === this.generation) this.rulesErrors.set(errorMessages(error));
    } finally {
      if (generation === this.generation) this.savingRules.set(false);
    }
  }

  /** Letting the AI receptionist book, or stopping it. Separate from saving, so it is never switched on by accident. */
  protected async toggleAiBooking(): Promise<void> {
    const settings = this.settings();
    if (!settings || !this.canEdit() || this.rulesDirty() || this.switching()) return;
    this.switching.set(true);
    this.switchProblems.set([]);
    const generation = this.generation;
    try {
      const updated = await firstValueFrom(this.api.updateSettings({ aiBookingEnabled: !settings.aiBookingEnabled }));
      if (generation !== this.generation) return;
      this.settings.set(updated);
    } catch (error) {
      if (generation === this.generation) this.switchProblems.set(errorMessages(error));
    } finally {
      if (generation === this.generation) this.switching.set(false);
    }
  }

  // ------------------------------------------------------------ editors

  /** Opens an editor unless another one holds unsaved changes (nothing typed is thrown away silently). */
  private openEditor(open: () => void): void {
    if (this.editorDirty()) {
      this.editorNotice.set('Save or discard the changes you are making first.');
      return;
    }
    this.editorNotice.set(null);
    this.editorErrors.set([]);
    this.providerDraft.set(null);
    this.typeDraft.set(null);
    open();
  }

  protected closeEditor(): void {
    this.editorNotice.set(null);
    this.editorErrors.set([]);
    this.providerDraft.set(null);
    this.typeDraft.set(null);
  }

  protected newProvider(): void {
    this.openEditor(() => this.providerDraft.set({ id: null, name: '', title: '', hours: emptyBusinessHours(), appointmentTypeIds: [] }));
  }

  protected editProvider(provider: Provider): void {
    this.openEditor(() =>
      this.providerDraft.set({ id: provider.id, name: provider.name, title: provider.title, hours: structuredClone(provider.hours), appointmentTypeIds: [...provider.appointmentTypeIds] }),
    );
  }

  protected setProvider<K extends keyof ProviderDraft>(field: K, value: ProviderDraft[K]): void {
    this.providerDraft.update((draft) => (draft ? { ...draft, [field]: value } : draft));
  }

  protected toggleProviderType(typeId: string, on: boolean): void {
    const draft = this.providerDraft();
    if (!draft) return;
    const ids = draft.appointmentTypeIds.filter((id) => id !== typeId);
    this.setProvider('appointmentTypeIds', on ? [...ids, typeId] : ids);
  }

  protected newType(): void {
    this.openEditor(() => this.typeDraft.set({ id: null, name: '', durationMinutes: '30', providerIds: [] }));
  }

  protected editType(type: AppointmentType): void {
    this.openEditor(() => this.typeDraft.set({ id: type.id, name: type.name, durationMinutes: String(type.durationMinutes), providerIds: [...type.providerIds] }));
  }

  protected setType<K extends keyof TypeDraft>(field: K, value: TypeDraft[K]): void {
    this.typeDraft.update((draft) => (draft ? { ...draft, [field]: value } : draft));
  }

  protected toggleTypeProvider(providerId: string, on: boolean): void {
    const draft = this.typeDraft();
    if (!draft) return;
    const ids = draft.providerIds.filter((id) => id !== providerId);
    this.setType('providerIds', on ? [...ids, providerId] : ids);
  }

  protected readonly canSaveEditor = computed(() => {
    if (!this.canEdit() || this.savingEditor()) return false;
    if (this.providerDraft()) return this.providerProblems().length === 0 && this.editorDirty();
    if (this.typeDraft()) return this.typeProblems().length === 0 && this.editorDirty();
    return false;
  });

  protected async saveEditor(): Promise<void> {
    if (!this.canSaveEditor()) return;
    const provider = this.providerDraft();
    const type = this.typeDraft();
    this.savingEditor.set(true);
    this.editorErrors.set([]);
    const generation = this.generation;
    try {
      if (provider) {
        await firstValueFrom(
          provider.id === null
            ? this.api.createProvider({ name: provider.name.trim(), title: provider.title.trim(), hours: provider.hours, appointmentTypeIds: provider.appointmentTypeIds })
            : this.api.updateProvider(provider.id, this.providerChanges()),
        );
      } else if (type) {
        await firstValueFrom(
          type.id === null
            ? this.api.createAppointmentType({ name: type.name.trim(), durationMinutes: Number(type.durationMinutes), providerIds: type.providerIds })
            : this.api.updateAppointmentType(type.id, this.typeChanges()),
        );
      }
      if (generation !== this.generation) return;
      this.providerDraft.set(null);
      this.typeDraft.set(null);
      // A provider's visit types and a visit type's providers are the same links: refresh both lists.
      await this.reloadLists(generation);
    } catch (error) {
      if (generation === this.generation) this.editorErrors.set(errorMessages(error));
    } finally {
      if (generation === this.generation) this.savingEditor.set(false);
    }
  }

  /** Switching a provider or a visit type off (or on again). Nothing is ever deleted. */
  protected async setActive(kind: 'provider' | 'type', id: string, active: boolean): Promise<void> {
    if (!this.canEdit()) return;
    this.listError.set(null);
    const generation = this.generation;
    try {
      if (kind === 'provider') await firstValueFrom(this.api.updateProvider(id, { active }));
      else await firstValueFrom(this.api.updateAppointmentType(id, { active }));
      if (generation !== this.generation) return;
      await this.reloadLists(generation);
    } catch (error) {
      if (generation === this.generation) this.listError.set(errorMessage(error));
    }
  }

  // ------------------------------------------------------------ days off

  protected async showTimeOff(provider: Provider): Promise<void> {
    if (this.timeOffProvider()?.id === provider.id) {
      this.timeOffProvider.set(null);
      return;
    }
    const today = todayIn(this.timeZone());
    this.timeOffProvider.set(provider);
    this.timeOffDraft.set({ startDate: today, startTime: '00:00', endDate: today, endTime: '23:59', reason: '' });
    this.timeOffError.set(null);
    this.timeOffList.set([]);
    this.timeOffLoading.set(true);
    const generation = this.generation;
    try {
      const list = await firstValueFrom(this.api.timeOff(provider.id));
      if (generation === this.generation && this.timeOffProvider()?.id === provider.id) this.timeOffList.set(list);
    } catch (error) {
      if (generation === this.generation) this.timeOffError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.timeOffLoading.set(false);
    }
  }

  protected setTimeOff<K extends keyof TimeOffDraft>(field: K, value: TimeOffDraft[K]): void {
    this.timeOffDraft.update((draft) => ({ ...draft, [field]: value }));
  }

  protected async addTimeOff(): Promise<void> {
    const provider = this.timeOffProvider();
    const range = this.timeOffRange();
    if (!provider || !this.canEdit() || this.savingTimeOff() || 'problem' in range) return;
    this.savingTimeOff.set(true);
    this.timeOffError.set(null);
    const generation = this.generation;
    try {
      const reason = this.timeOffDraft().reason.trim();
      const created = await firstValueFrom(
        this.api.addTimeOff(provider.id, { startsAt: range.startsAt.toISOString(), endsAt: range.endsAt.toISOString(), ...(reason ? { reason } : {}) }),
      );
      if (generation !== this.generation) return;
      this.timeOffList.update((list) => [...list, created].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
      this.setTimeOff('reason', '');
    } catch (error) {
      if (generation === this.generation) this.timeOffError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.savingTimeOff.set(false);
    }
  }

  protected async cancelTimeOff(timeOff: ProviderTimeOff): Promise<void> {
    if (!this.canEdit()) return;
    this.timeOffError.set(null);
    const generation = this.generation;
    try {
      await firstValueFrom(this.api.cancelTimeOff(timeOff.id));
      if (generation === this.generation) this.timeOffList.update((list) => list.filter((item) => item.id !== timeOff.id));
    } catch (error) {
      if (generation === this.generation) this.timeOffError.set(errorMessage(error));
    }
  }

  // ---------------------------------------------------------------- load

  private async reloadLists(generation: number): Promise<void> {
    const [providers, types] = await Promise.all([firstValueFrom(this.api.providers()), firstValueFrom(this.api.appointmentTypes())]);
    if (generation !== this.generation) return;
    this.providers.set(providers);
    this.types.set(types);
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.loadError.set(null);
    this.settings.set(null);
    this.rules.set(null);
    this.providers.set([]);
    this.types.set([]);
    this.closeEditor();
    this.timeOffProvider.set(null);
    this.rulesErrors.set([]);
    this.switchProblems.set([]);
    this.rulesSaved.set(false);
    this.listError.set(null);
    try {
      const [settings, providers, types] = await Promise.all([
        firstValueFrom(this.api.settings()),
        firstValueFrom(this.api.providers()),
        firstValueFrom(this.api.appointmentTypes()),
      ]);
      if (generation !== this.generation) return;
      this.settings.set(settings);
      this.rules.set(toRulesDraft(settings));
      this.providers.set(providers);
      this.types.set(types);
    } catch (error) {
      if (generation === this.generation) this.loadError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
