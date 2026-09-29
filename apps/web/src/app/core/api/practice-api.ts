import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { AuditLogPage, MemberSummary, PracticeDetails } from '@frontdesk/shared';
import type { Observable } from 'rxjs';

/** Calls to the API for the signed-in practice. The practice itself is never sent: the server reads it from the session. */
@Injectable({ providedIn: 'root' })
export class PracticeApi {
  private readonly http = inject(HttpClient);

  practice(): Observable<PracticeDetails> {
    return this.http.get<PracticeDetails>('/api/practice');
  }

  members(): Observable<MemberSummary[]> {
    return this.http.get<MemberSummary[]>('/api/members');
  }

  auditLogs(options: { limit?: number; cursor?: string | null } = {}): Observable<AuditLogPage> {
    let params = new HttpParams();
    if (options.limit !== undefined) params = params.set('limit', options.limit);
    if (options.cursor) params = params.set('cursor', options.cursor);
    return this.http.get<AuditLogPage>('/api/audit-logs', { params });
  }
}
