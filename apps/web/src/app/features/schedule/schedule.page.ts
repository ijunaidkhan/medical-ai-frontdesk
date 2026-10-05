import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  APPOINTMENT_CANCEL_REASON_MAX_LENGTH,
  isValidBirthDate,
  PATIENT_NAME_MAX_LENGTH,
  PATIENT_SEARCH_MIN_LENGTH,
  PHONE_PATTERN,
  type Appointment,
  type AppointmentType,
  type AvailabilitySlot,
  type Patient,
  type Provider,
  type TimeFormat,
} from '@frontdesk/shared';
import { firstValueFrom } from 'rxjs';
import { errorMessage } from '../../core/api/api-error';
import { SchedulingApi } from '../../core/api/scheduling-api';
import { AuthService } from '../../core/auth/auth.service';
import { addDays, formatClock, formatDayHeading, formatWhen, localParts, mondayOf, todayIn, zonedInstant } from '../../core/zoned-time';

type View = 'day' | 'week';

/** How many open times one search shows. */
const SLOTS_SHOWN = 20;

interface NewPatientDraft {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phone: string;
}

/** One booking (or move) being prepared. The key is reused if the same attempt is sent again, so it is booked once. */
interface Attempt {
  key: string;
  /** What the key was made for: a different slot or patient is a different attempt with a new key. */
  for: string;
}

const emptyPatient = (): NewPatientDraft => ({ firstName: '', lastName: '', dateOfBirth: '', phone: '' });

/** A key the API accepts (letters, digits and dashes), different for every new attempt. */
export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

/** Midnight at the start of a practice date (or the first minute that exists, if the clocks jumped at midnight). */
function startOfDay(date: string, timeZone: string): Date {
  return zonedInstant(date, '00:00', timeZone) ?? zonedInstant(date, '01:00', timeZone) ?? new Date(`${date}T00:00:00Z`);
}

/** The time was taken, or is no longer offered: the open times shown are out of date. */
const isConflict = (error: unknown) => error instanceof HttpErrorResponse && error.status === 409;

/**
 * The practice's appointments, a day or a week at a time, and booking, cancelling and moving them.
 * Times are on the practice's clock. Open times come from the API (exactly what a caller would be
 * offered) and every booking is checked again there.
 */
@Component({
  selector: 'app-schedule-page',
  templateUrl: './schedule.page.html',
  styleUrl: './schedule.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SchedulePage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(SchedulingApi);

  protected readonly limits = { name: PATIENT_NAME_MAX_LENGTH, reason: APPOINTMENT_CANCEL_REASON_MAX_LENGTH, search: PATIENT_SEARCH_MIN_LENGTH };
  protected readonly canManage = computed(() => this.auth.can('schedule:manage'));
  protected readonly canFindPatients = computed(() => this.auth.can('patients:read'));
  protected readonly timeZone = computed(() => this.auth.practice()?.timezone ?? 'UTC');

  // ------------------------------------------------------------- calendar

  protected readonly view = signal<View>('day');
  protected readonly anchor = signal(todayIn(this.timeZone()));
  protected readonly providerFilter = signal('');
  protected readonly showCancelled = signal(false);

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly timeFormat = signal<TimeFormat>('12h');
  protected readonly providers = signal<Provider[]>([]);
  protected readonly types = signal<AppointmentType[]>([]);
  protected readonly appointments = signal<Appointment[]>([]);
  protected readonly calendarLoading = signal(false);
  protected readonly calendarError = signal<string | null>(null);

  /** The practice dates on screen. */
  protected readonly days = computed(() => {
    const first = this.view() === 'week' ? mondayOf(this.anchor()) : this.anchor();
    return Array.from({ length: this.view() === 'week' ? 7 : 1 }, (_, i) => addDays(first, i));
  });

  protected readonly title = computed(() => {
    const days = this.days();
    return days.length === 1 ? formatDayHeading(days[0]!) : `${formatDayHeading(days[0]!)} to ${formatDayHeading(days.at(-1)!)}`;
  });

  /** The appointments on screen, grouped by practice date, earliest first. */
  protected readonly byDay = computed(() => {
    const groups = new Map(this.days().map((day) => [day, [] as Appointment[]]));
    for (const appointment of this.appointments()) {
      groups.get(localParts(appointment.startsAt, this.timeZone()).date)?.push(appointment);
    }
    return [...groups.entries()].map(([date, items]) => ({ date, heading: formatDayHeading(date), items: items.sort((a, b) => a.startsAt.localeCompare(b.startsAt)) }));
  });

  protected readonly activeProviders = computed(() => this.providers().filter((provider) => provider.active));
  protected readonly activeTypes = computed(() => this.types().filter((type) => type.active && type.providerIds.length > 0));

  // ------------------------------------------------------------- booking

  protected readonly booking = signal(false);
  protected readonly bookType = signal('');
  protected readonly bookProvider = signal('');
  protected readonly bookFrom = signal('');
  protected readonly slots = signal<AvailabilitySlot[] | null>(null);
  protected readonly slotsLoading = signal(false);
  protected readonly chosenSlot = signal<AvailabilitySlot | null>(null);
  protected readonly patientQuery = signal('');
  protected readonly patientResults = signal<Patient[] | null>(null);
  protected readonly searching = signal(false);
  protected readonly chosenPatient = signal<Patient | null>(null);
  protected readonly addingPatient = signal(false);
  protected readonly newPatient = signal<NewPatientDraft>(emptyPatient());
  protected readonly saving = signal(false);
  protected readonly bookingError = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  private attempt: Attempt | null = null;

  protected readonly newPatientProblems = computed(() => {
    const draft = this.newPatient();
    const problems: string[] = [];
    if (draft.firstName.trim() === '' || draft.lastName.trim() === '') problems.push('Write the first and last name.');
    if (!isValidBirthDate(draft.dateOfBirth)) problems.push('Choose a real date of birth.');
    if (!PHONE_PATTERN.test(draft.phone.trim())) problems.push('Write the phone number with the country code, for example +14155550123.');
    return problems;
  });

  protected readonly canConfirm = computed(
    () => this.canManage() && !this.saving() && this.chosenSlot() !== null && (this.chosenPatient() !== null || (this.addingPatient() && this.newPatientProblems().length === 0)),
  );

  // -------------------------------------------------- cancelling, moving

  protected readonly cancelling = signal<Appointment | null>(null);
  protected readonly cancelReason = signal('');
  protected readonly moving = signal<Appointment | null>(null);
  protected readonly moveSlots = signal<AvailabilitySlot[] | null>(null);
  protected readonly actionError = signal<string | null>(null);

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

  protected clock(iso: string): string {
    return formatClock(iso, this.timeZone(), this.timeFormat());
  }

  protected when(iso: string): string {
    return formatWhen(iso, this.timeZone(), this.timeFormat());
  }

  protected typeName(id: string): string {
    return this.types().find((type) => type.id === id)?.name ?? '';
  }

  // ------------------------------------------------------- moving around

  protected setView(view: View): void {
    this.view.set(view);
    void this.loadCalendar();
  }

  protected step(direction: -1 | 1): void {
    this.anchor.update((date) => addDays(date, direction * (this.view() === 'week' ? 7 : 1)));
    void this.loadCalendar();
  }

  protected today(): void {
    this.anchor.set(todayIn(this.timeZone()));
    void this.loadCalendar();
  }

  protected goTo(date: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    this.anchor.set(date);
    void this.loadCalendar();
  }

  protected filterProvider(id: string): void {
    this.providerFilter.set(id);
    void this.loadCalendar();
  }

  protected toggleCancelled(show: boolean): void {
    this.showCancelled.set(show);
    void this.loadCalendar();
  }

  // ------------------------------------------------------------- booking

  protected openBooking(): void {
    this.booking.set(true);
    this.notice.set(null);
    this.resetBooking();
    this.bookFrom.set(todayIn(this.timeZone()));
  }

  protected closeBooking(): void {
    this.booking.set(false);
    this.resetBooking();
  }

  private resetBooking(): void {
    this.bookType.set('');
    this.bookProvider.set('');
    this.slots.set(null);
    this.chosenSlot.set(null);
    this.patientQuery.set('');
    this.patientResults.set(null);
    this.chosenPatient.set(null);
    this.addingPatient.set(false);
    this.newPatient.set(emptyPatient());
    this.bookingError.set(null);
    this.attempt = null;
  }

  protected setBookType(id: string): void {
    this.bookType.set(id);
    this.bookProvider.set('');
    this.slots.set(null);
    this.chosenSlot.set(null);
  }

  protected providersFor(typeId: string): Provider[] {
    const type = this.types().find((candidate) => candidate.id === typeId);
    return this.activeProviders().filter((provider) => type?.providerIds.includes(provider.id));
  }

  protected async findTimes(): Promise<void> {
    if (!this.bookType()) return;
    this.chosenSlot.set(null);
    this.bookingError.set(null);
    this.slots.set(await this.search(this.bookType(), this.bookProvider() || undefined, this.bookFrom(), (message) => this.bookingError.set(message)));
  }

  protected chooseSlot(slot: AvailabilitySlot): void {
    this.chosenSlot.set(slot);
  }

  protected setPatientQuery(text: string): void {
    this.patientQuery.set(text);
  }

  protected async searchPatients(): Promise<void> {
    const query = this.patientQuery().trim();
    if (query.length < PATIENT_SEARCH_MIN_LENGTH || !this.canFindPatients()) return;
    this.searching.set(true);
    this.bookingError.set(null);
    const generation = this.generation;
    try {
      const results = await firstValueFrom(this.api.searchPatients(query));
      if (generation === this.generation) this.patientResults.set(results);
    } catch (error) {
      if (generation === this.generation) this.bookingError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.searching.set(false);
    }
  }

  protected choosePatient(patient: Patient): void {
    this.chosenPatient.set(patient);
    this.addingPatient.set(false);
  }

  protected startNewPatient(): void {
    this.chosenPatient.set(null);
    this.addingPatient.set(true);
  }

  protected setNewPatient<K extends keyof NewPatientDraft>(field: K, value: string): void {
    this.newPatient.update((draft) => ({ ...draft, [field]: value }));
  }

  /** The same key for the same attempt (a retry after a lost answer books once); a new key for anything else. */
  private keyFor(purpose: string): string {
    if (!this.attempt || this.attempt.for !== purpose) this.attempt = { key: newIdempotencyKey(), for: purpose };
    return this.attempt.key;
  }

  protected async confirmBooking(): Promise<void> {
    const slot = this.chosenSlot();
    if (!slot || !this.canConfirm()) return;
    this.saving.set(true);
    this.bookingError.set(null);
    const generation = this.generation;
    try {
      let patient = this.chosenPatient();
      if (!patient) {
        const draft = this.newPatient();
        patient = await firstValueFrom(
          this.api.addPatient({ firstName: draft.firstName.trim(), lastName: draft.lastName.trim(), dateOfBirth: draft.dateOfBirth, phone: draft.phone.trim() }),
        );
        if (generation !== this.generation) return;
        // Remember who was added, so a retry books for the same patient instead of adding them again.
        this.chosenPatient.set(patient);
        this.addingPatient.set(false);
      }
      const key = this.keyFor(`book|${slot.providerId}|${slot.appointmentTypeId}|${slot.startsAt}|${patient.id}`);
      const booked = await firstValueFrom(this.api.book({ patientId: patient.id, providerId: slot.providerId, appointmentTypeId: slot.appointmentTypeId, startsAt: slot.startsAt }, key));
      if (generation !== this.generation) return;
      this.notice.set(`Booked: ${booked.patient.firstName} ${booked.patient.lastName}, ${booked.appointmentTypeName} with ${booked.providerName}, ${this.when(booked.startsAt)}.`);
      this.booking.set(false);
      this.resetBooking();
      this.anchor.set(localParts(booked.startsAt, this.timeZone()).date);
      await this.loadCalendar();
    } catch (error) {
      if (generation !== this.generation) return;
      if (isConflict(error)) {
        // The time was taken (or is no longer offered): show what is open now.
        const message = `${errorMessage(error)}. Here are the times open now.`;
        this.attempt = null;
        await this.findTimes();
        this.bookingError.set(message);
      } else {
        this.bookingError.set(errorMessage(error));
      }
    } finally {
      if (generation === this.generation) this.saving.set(false);
    }
  }

  // ------------------------------------------------- cancelling, moving

  protected startCancel(appointment: Appointment): void {
    this.moving.set(null);
    this.actionError.set(null);
    this.cancelReason.set('');
    this.cancelling.set(appointment);
  }

  protected async confirmCancel(): Promise<void> {
    const appointment = this.cancelling();
    if (!appointment || !this.canManage() || this.saving()) return;
    this.saving.set(true);
    this.actionError.set(null);
    const generation = this.generation;
    try {
      await firstValueFrom(this.api.cancel(appointment.id, this.cancelReason().trim()));
      if (generation !== this.generation) return;
      this.cancelling.set(null);
      this.notice.set(`Cancelled: ${appointment.patient.firstName} ${appointment.patient.lastName}, ${this.when(appointment.startsAt)}.`);
      await this.loadCalendar();
    } catch (error) {
      if (generation === this.generation) this.actionError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.saving.set(false);
    }
  }

  protected async startMove(appointment: Appointment): Promise<void> {
    this.cancelling.set(null);
    this.actionError.set(null);
    this.moving.set(appointment);
    this.moveSlots.set(null);
    this.attempt = null;
    this.moveSlots.set(await this.search(appointment.appointmentTypeId, undefined, todayIn(this.timeZone()), (message) => this.actionError.set(message)));
  }

  protected async confirmMove(slot: AvailabilitySlot): Promise<void> {
    const appointment = this.moving();
    if (!appointment || !this.canManage() || this.saving()) return;
    this.saving.set(true);
    this.actionError.set(null);
    const generation = this.generation;
    try {
      const key = this.keyFor(`move|${appointment.id}|${slot.providerId}|${slot.startsAt}`);
      const moved = await firstValueFrom(this.api.reschedule(appointment.id, { startsAt: slot.startsAt, providerId: slot.providerId }, key));
      if (generation !== this.generation) return;
      this.moving.set(null);
      this.attempt = null;
      this.notice.set(`Moved: ${moved.patient.firstName} ${moved.patient.lastName} to ${this.when(moved.startsAt)} with ${moved.providerName}.`);
      await this.loadCalendar();
    } catch (error) {
      if (generation !== this.generation) return;
      if (isConflict(error)) {
        this.attempt = null;
        this.moveSlots.set(await this.search(appointment.appointmentTypeId, undefined, todayIn(this.timeZone()), (message) => this.actionError.set(message)));
      }
      this.actionError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.saving.set(false);
    }
  }

  protected closeAction(): void {
    this.cancelling.set(null);
    this.moving.set(null);
    this.actionError.set(null);
    this.attempt = null;
  }

  // ---------------------------------------------------------------- load

  /** Open times for a visit, from a practice date onwards; null when the search failed (the reason goes to `onError`). */
  private async search(typeId: string, providerId: string | undefined, fromDate: string, onError: (message: string) => void): Promise<AvailabilitySlot[] | null> {
    const generation = this.generation;
    this.slotsLoading.set(true);
    try {
      const today = todayIn(this.timeZone());
      const from = fromDate && fromDate > today ? startOfDay(fromDate, this.timeZone()).toISOString() : undefined;
      const result = await firstValueFrom(this.api.availability({ appointmentTypeId: typeId, providerId, from, limit: SLOTS_SHOWN }));
      return generation === this.generation ? result.slots : null;
    } catch (error) {
      if (generation === this.generation) onError(errorMessage(error));
      return null;
    } finally {
      if (generation === this.generation) this.slotsLoading.set(false);
    }
  }

  private async loadCalendar(): Promise<void> {
    const generation = this.generation;
    const days = this.days();
    this.calendarLoading.set(true);
    this.calendarError.set(null);
    try {
      const list = await firstValueFrom(
        this.api.appointments({
          from: startOfDay(days[0]!, this.timeZone()).toISOString(),
          to: startOfDay(addDays(days.at(-1)!, 1), this.timeZone()).toISOString(),
          providerId: this.providerFilter() || undefined,
          status: this.showCancelled() ? 'all' : 'booked',
        }),
      );
      if (generation === this.generation && days === this.days()) this.appointments.set(list);
    } catch (error) {
      if (generation === this.generation) this.calendarError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.calendarLoading.set(false);
    }
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.loadError.set(null);
    this.appointments.set([]);
    this.providers.set([]);
    this.types.set([]);
    this.providerFilter.set('');
    this.booking.set(false);
    this.resetBooking();
    this.closeAction();
    this.notice.set(null);
    this.anchor.set(todayIn(this.timeZone()));
    try {
      const [settings, providers, types] = await Promise.all([
        firstValueFrom(this.api.settings()),
        firstValueFrom(this.api.providers()),
        firstValueFrom(this.api.appointmentTypes()),
      ]);
      if (generation !== this.generation) return;
      this.timeFormat.set(settings.timeFormat);
      this.providers.set(providers);
      this.types.set(types);
      await this.loadCalendar();
    } catch (error) {
      if (generation === this.generation) this.loadError.set(errorMessage(error));
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
