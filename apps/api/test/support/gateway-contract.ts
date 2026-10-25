import { ConflictException } from '@nestjs/common';
import { CancellationWindowError } from '../../src/scheduling/appointments.service.js';
import type { AppointmentRecord, BookRequest, GatewayScope, SchedulingGateway } from '../../src/scheduling/gateway/scheduling-gateway.js';

const DAY = 86_400_000;

/** What the contract needs from the calendar behind a gateway: two practices, one visit type, one known patient. */
export interface GatewayWorld {
  gateway: SchedulingGateway;
  /** Runs `work` in its own transaction for one practice, committed at the end. */
  run<T>(practice: 'home' | 'other', work: (scope: GatewayScope) => Promise<T>): Promise<T>;
  /** A visit type of `home`, 30 minutes long, bookable by callers at any hour, with no notice needed. */
  visitTypeName: string;
  /** A patient of `home`. */
  patient: { firstName: string; lastName: string; dateOfBirth: string; phone: string };
  /** The shortest notice, in hours, for a caller to cancel or move. Starts at 0. */
  setCancellationWindowHours(hours: number): Promise<void>;
  /** Puts a booked appointment for the patient yesterday (it cannot be booked through the gateway) and returns its id. */
  addPastAppointment(): Promise<string>;
  close(): Promise<void>;
}

/**
 * The behaviour the AI receptionist's tools rely on, whatever calendar is behind the gateway. Every adapter runs
 * this same suite, so our own calendar and an EHR look the same to the tools.
 */
export function describeGatewayContract(name: string, setup: () => Promise<GatewayWorld>): void {
  describe(`scheduling gateway contract: ${name}`, () => {
    let world: GatewayWorld;
    let typeId: string;
    let patientId: string;
    let counter = 0;
    const key = (label: string) => `contract-${label}-${(counter += 1)}-${Math.random().toString(36).slice(2, 10)}`;
    const home = <T>(work: (gateway: SchedulingGateway, scope: GatewayScope) => Promise<T>) => world.run('home', (scope) => work(world.gateway, scope));
    const other = <T>(work: (gateway: SchedulingGateway, scope: GatewayScope) => Promise<T>) => world.run('other', (scope) => work(world.gateway, scope));

    /** Open times for the visit type over the next two weeks, earliest first. */
    const openTimes = () => home((g, scope) => g.findSlots(scope, { appointmentTypeId: typeId, from: new Date(), to: new Date(Date.now() + 14 * DAY), limit: 40, now: new Date() }));
    /** A booking request for the earliest open time. */
    const nextOpen = async (patient: BookRequest['patient'] = { id: patientId }): Promise<BookRequest> => {
      const [slot] = await openTimes();
      return { patient, providerId: slot!.providerId, appointmentTypeId: typeId, startsAt: new Date(slot!.startsAt), idempotencyKey: key('book'), conversationId: null };
    };
    const book = async (request?: BookRequest): Promise<AppointmentRecord> => {
      const chosen = request ?? (await nextOpen());
      return home((g, scope) => g.book(scope, chosen));
    };
    const upcomingIds = async () => (await home((g, scope) => g.listAppointments(scope, patientId, 50))).map((appointment) => appointment.id);
    const stranger = () => ({ firstName: 'Nadia', lastName: `Contract${(counter += 1)}`, dateOfBirth: '1992-04-05', phone: `+1415555${String(1000 + counter).padStart(4, '0')}` });

    beforeAll(async () => {
      world = await setup();
      const types = await home((g, scope) => g.listVisitTypes(scope));
      typeId = types.find((type) => type.name === world.visitTypeName)!.id;
      const { firstName, lastName, dateOfBirth } = world.patient;
      patientId = (await home((g, scope) => g.findPatient(scope, { fullName: `${firstName} ${lastName}`, dateOfBirth })))!.id;
    });
    afterAll(() => world.close());

    it('lists the visit types a caller can book', async () => {
      expect(await home((g, scope) => g.listVisitTypes(scope))).toContainEqual({ id: typeId, name: world.visitTypeName, durationMinutes: 30 });
    });

    it('finds open times for the visit type, earliest first, inside the window asked for', async () => {
      const from = new Date();
      const to = new Date(from.getTime() + 7 * DAY);
      const slots = await home((g, scope) => g.findSlots(scope, { appointmentTypeId: typeId, from, to, limit: 10, now: from }));
      expect(slots.length).toBeGreaterThan(0);
      expect(slots.length).toBeLessThanOrEqual(10);
      const starts = slots.map((slot) => new Date(slot.startsAt).getTime());
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
      for (const slot of slots) {
        expect(slot.appointmentTypeId).toBe(typeId);
        expect(new Date(slot.startsAt).getTime()).toBeGreaterThanOrEqual(from.getTime());
        expect(new Date(slot.startsAt).getTime()).toBeLessThan(to.getTime());
        expect(new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime()).toBe(30 * 60_000);
      }
    });

    describe('finding a patient', () => {
      it('by name and date of birth, without regard to capital letters', async () => {
        const { firstName, lastName, dateOfBirth, phone } = world.patient;
        expect(await home((g, scope) => g.findPatient(scope, { fullName: `${firstName.toUpperCase()} ${lastName.toLowerCase()}`, dateOfBirth }))).toEqual({ id: patientId, phone });
      });

      it('by all four details, and not with another phone number', async () => {
        expect((await home((g, scope) => g.findPatient(scope, world.patient)))?.id).toBe(patientId);
        expect(await home((g, scope) => g.findPatient(scope, { ...world.patient, phone: '+14155559999' }))).toBeNull();
      });

      it('finds no one for another birth date or an unknown name', async () => {
        const { firstName, lastName, dateOfBirth } = world.patient;
        expect(await home((g, scope) => g.findPatient(scope, { fullName: `${firstName} ${lastName}`, dateOfBirth: '1950-01-01' }))).toBeNull();
        expect(await home((g, scope) => g.findPatient(scope, { fullName: 'Nobody Known', dateOfBirth }))).toBeNull();
      });
    });

    describe('booking', () => {
      it('books a time for a known patient, lists it, and the same key books once', async () => {
        const [slot] = await openTimes();
        const request: BookRequest = { patient: { id: patientId }, providerId: slot!.providerId, appointmentTypeId: typeId, startsAt: new Date(slot!.startsAt), idempotencyKey: key('once'), conversationId: null };
        const booked = await book(request);
        expect(booked).toEqual({ id: booked.id, patientId, appointmentTypeId: typeId, facts: { typeName: world.visitTypeName, providerName: slot!.providerName, startsAt: new Date(slot!.startsAt) } });

        expect((await book(request)).id).toBe(booked.id);
        expect((await upcomingIds()).filter((id) => id === booked.id)).toHaveLength(1);
        expect(await home((g, scope) => g.getAppointment(scope, booked.id))).toEqual(booked);
        // A booked time is no longer offered.
        expect((await openTimes()).some((open) => open.providerId === slot!.providerId && open.startsAt === slot!.startsAt)).toBe(false);
      });

      it('refuses a time someone else already has, as a conflict', async () => {
        const first = await nextOpen();
        await book(first);
        const taken = home((g, scope) => g.book(scope, { ...first, patient: { create: stranger() }, idempotencyKey: key('taken') }));
        await expect(taken).rejects.toBeInstanceOf(ConflictException);
      });

      it('adds someone new when booking for them', async () => {
        const person = stranger();
        const booked = await book(await nextOpen({ create: person }));
        expect(booked.patientId).not.toBe(patientId);
        expect(await home((g, scope) => g.findPatient(scope, { fullName: `${person.firstName} ${person.lastName}`, dateOfBirth: person.dateOfBirth }))).toEqual({ id: booked.patientId, phone: person.phone });
      });
    });

    it('lists only upcoming booked appointments, soonest first', async () => {
      const past = await world.addPastAppointment();
      const first = await book();
      const second = await book();
      const upcoming = await home((g, scope) => g.listAppointments(scope, patientId, 50));
      const ids = upcoming.map((appointment) => appointment.id);
      expect(ids).not.toContain(past);
      expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
      const starts = upcoming.map((appointment) => appointment.facts.startsAt.getTime());
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
      expect((await home((g, scope) => g.getAppointment(scope, past)))?.id).toBe(past);
    });

    describe('cancelling', () => {
      it('cancels: the appointment is no longer upcoming but is kept, and cannot be cancelled twice', async () => {
        const booked = await book();
        await home((g, scope) => g.cancel(scope, booked.id, 'contract test'));
        expect(await upcomingIds()).not.toContain(booked.id);
        expect((await home((g, scope) => g.getAppointment(scope, booked.id)))?.id).toBe(booked.id);
        await expect(home((g, scope) => g.cancel(scope, booked.id, 'again'))).rejects.toBeInstanceOf(ConflictException);
      });

      it('refuses to cancel or move inside the cancellation window', async () => {
        const booked = await book();
        await world.setCancellationWindowHours(720);
        try {
          await expect(home((g, scope) => g.cancel(scope, booked.id, 'too late'))).rejects.toBeInstanceOf(CancellationWindowError);
          const [later] = (await openTimes()).slice(-1);
          const move = home((g, scope) => g.reschedule(scope, booked.id, { providerId: later!.providerId, startsAt: new Date(later!.startsAt), idempotencyKey: key('late-move'), conversationId: null }));
          await expect(move).rejects.toBeInstanceOf(CancellationWindowError);
        } finally {
          await world.setCancellationWindowHours(0);
        }
        expect(await upcomingIds()).toContain(booked.id);
      });
    });

    describe('moving', () => {
      it('moves to a new time, the old one is released, and the same key moves once', async () => {
        const booked = await book();
        const [later] = (await openTimes()).slice(-1);
        const request = { providerId: later!.providerId, startsAt: new Date(later!.startsAt), idempotencyKey: key('move'), conversationId: null };
        const moved = await home((g, scope) => g.reschedule(scope, booked.id, request));
        expect(moved).toMatchObject({ patientId, appointmentTypeId: typeId, facts: { startsAt: new Date(later!.startsAt), providerName: later!.providerName } });
        expect(moved.id).not.toBe(booked.id);

        expect((await home((g, scope) => g.reschedule(scope, booked.id, request))).id).toBe(moved.id);
        const upcoming = await upcomingIds();
        expect(upcoming).toContain(moved.id);
        expect(upcoming).not.toContain(booked.id);
        expect((await openTimes()).some((open) => open.startsAt === booked.facts.startsAt.toISOString() && open.providerId === later!.providerId)).toBe(true);
      });
    });

    describe('practices are kept apart', () => {
      it('another practice sees none of this practice\'s visit types, patients or appointments', async () => {
        const booked = await book();
        expect((await other((g, scope) => g.listVisitTypes(scope))).map((type) => type.id)).not.toContain(typeId);
        expect(await other((g, scope) => g.findPatient(scope, world.patient))).toBeNull();
        const { firstName, lastName, dateOfBirth } = world.patient;
        expect(await other((g, scope) => g.findPatient(scope, { fullName: `${firstName} ${lastName}`, dateOfBirth }))).toBeNull();
        expect(await other((g, scope) => g.listAppointments(scope, patientId, 50))).toEqual([]);
        expect(await other((g, scope) => g.getAppointment(scope, booked.id))).toBeNull();
      });

      it('another practice cannot book, cancel or move with this practice\'s ids', async () => {
        const request = await nextOpen();
        await expect(other((g, scope) => g.book(scope, request))).rejects.toThrow();
        const booked = await book();
        await expect(other((g, scope) => g.cancel(scope, booked.id, 'not theirs'))).rejects.toThrow();
        expect(await upcomingIds()).toContain(booked.id);
      });
    });
  });
}
