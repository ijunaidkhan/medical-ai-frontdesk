import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  AiSettings,
  CreateTransferTargetRequest,
  TransferTarget,
  UpdateAiSettingsRequest,
  UpdateTransferTargetRequest,
} from '@frontdesk/shared';
import type { Observable } from 'rxjs';

/** The AI receptionist's configuration for the signed-in practice. The practice is never sent: the server reads it from the session. */
@Injectable({ providedIn: 'root' })
export class AiApi {
  private readonly http = inject(HttpClient);

  settings(): Observable<AiSettings> {
    return this.http.get<AiSettings>('/api/ai/settings');
  }

  updateSettings(changes: UpdateAiSettingsRequest): Observable<AiSettings> {
    return this.http.patch<AiSettings>('/api/ai/settings', changes);
  }

  transferTargets(): Observable<TransferTarget[]> {
    return this.http.get<TransferTarget[]>('/api/ai/transfer-targets');
  }

  createTransferTarget(target: CreateTransferTargetRequest): Observable<TransferTarget> {
    return this.http.post<TransferTarget>('/api/ai/transfer-targets', target);
  }

  updateTransferTarget(id: string, changes: UpdateTransferTargetRequest): Observable<TransferTarget> {
    return this.http.patch<TransferTarget>(`/api/ai/transfer-targets/${encodeURIComponent(id)}`, changes);
  }
}
