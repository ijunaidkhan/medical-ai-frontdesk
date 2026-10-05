import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  Appointment,
  AppointmentStatus,
  AppointmentType,
  AvailabilityResponse,
  BookAppointmentRequest,
  CreateAppointmentTypeRequest,
  CreatePatientRequest,
  CreateProviderRequest,
  CreateTimeOffRequest,
  Patient,
  Provider,
  ProviderTimeOff,
  RescheduleAppointmentRequest,
  SchedulingSettings,
  UpdateAppointmentTypeRequest,
  UpdateProviderRequest,
  UpdateSchedulingSettingsRequest,
} from '@frontdesk/shared';
import type { Observable } from 'rxjs';

const id = (value: string) => encodeURIComponent(value);

/** Only the filters that are set become query parameters. */
function params(values: Record<string, string | number | undefined>): HttpParams {
  let result = new HttpParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') result = result.set(key, String(value));
  }
  return result;
}

export interface AppointmentFilter {
  from: string;
  to: string;
  providerId?: string;
  patientId?: string;
  status?: AppointmentStatus | 'all';
}

export interface AvailabilityFilter {
  appointmentTypeId: string;
  providerId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** Scheduling for the signed-in practice: setup, open times, patients and appointments. The practice is never sent. */
@Injectable({ providedIn: 'root' })
export class SchedulingApi {
  private readonly http = inject(HttpClient);

  // ---------------------------------------------------------------- setup

  settings(): Observable<SchedulingSettings> {
    return this.http.get<SchedulingSettings>('/api/scheduling/settings');
  }

  updateSettings(changes: UpdateSchedulingSettingsRequest): Observable<SchedulingSettings> {
    return this.http.patch<SchedulingSettings>('/api/scheduling/settings', changes);
  }

  providers(): Observable<Provider[]> {
    return this.http.get<Provider[]>('/api/providers');
  }

  createProvider(provider: CreateProviderRequest): Observable<Provider> {
    return this.http.post<Provider>('/api/providers', provider);
  }

  updateProvider(providerId: string, changes: UpdateProviderRequest): Observable<Provider> {
    return this.http.patch<Provider>(`/api/providers/${id(providerId)}`, changes);
  }

  timeOff(providerId: string): Observable<ProviderTimeOff[]> {
    return this.http.get<ProviderTimeOff[]>(`/api/providers/${id(providerId)}/time-off`);
  }

  addTimeOff(providerId: string, timeOff: CreateTimeOffRequest): Observable<ProviderTimeOff> {
    return this.http.post<ProviderTimeOff>(`/api/providers/${id(providerId)}/time-off`, timeOff);
  }

  cancelTimeOff(timeOffId: string): Observable<ProviderTimeOff> {
    return this.http.post<ProviderTimeOff>(`/api/provider-time-off/${id(timeOffId)}/cancel`, {});
  }

  appointmentTypes(): Observable<AppointmentType[]> {
    return this.http.get<AppointmentType[]>('/api/appointment-types');
  }

  createAppointmentType(type: CreateAppointmentTypeRequest): Observable<AppointmentType> {
    return this.http.post<AppointmentType>('/api/appointment-types', type);
  }

  updateAppointmentType(typeId: string, changes: UpdateAppointmentTypeRequest): Observable<AppointmentType> {
    return this.http.patch<AppointmentType>(`/api/appointment-types/${id(typeId)}`, changes);
  }

  // ------------------------------------------------- open times, patients

  availability(filter: AvailabilityFilter): Observable<AvailabilityResponse> {
    return this.http.get<AvailabilityResponse>('/api/availability', { params: params({ ...filter }) });
  }

  searchPatients(query: string): Observable<Patient[]> {
    return this.http.get<Patient[]>('/api/patients', { params: params({ q: query }) });
  }

  /** Adds a patient, or returns the one who already matches on name, date of birth and phone. */
  addPatient(patient: CreatePatientRequest): Observable<Patient> {
    return this.http.post<Patient>('/api/patients', patient);
  }

  // --------------------------------------------------------- appointments

  appointments(filter: AppointmentFilter): Observable<Appointment[]> {
    return this.http.get<Appointment[]>('/api/appointments', { params: params({ ...filter, limit: 500 }) });
  }

  /** `key` must be the same when the same booking is retried, so it is booked once. */
  book(booking: BookAppointmentRequest, key: string): Observable<Appointment> {
    return this.http.post<Appointment>('/api/appointments', booking, { headers: { 'Idempotency-Key': key } });
  }

  cancel(appointmentId: string, reason: string): Observable<Appointment> {
    return this.http.post<Appointment>(`/api/appointments/${id(appointmentId)}/cancel`, reason ? { reason } : {});
  }

  reschedule(appointmentId: string, move: RescheduleAppointmentRequest, key: string): Observable<Appointment> {
    return this.http.post<Appointment>(`/api/appointments/${id(appointmentId)}/reschedule`, move, { headers: { 'Idempotency-Key': key } });
  }
}
