import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { StartWebCallResponse } from '@frontdesk/shared';
import type { Observable } from 'rxjs';

/** The web phone: a spoken test call with the signed-in practice's AI receptionist (development only on the server). */
@Injectable({ providedIn: 'root' })
export class VoiceApi {
  private readonly http = inject(HttpClient);

  startWebCall(): Observable<StartWebCallResponse> {
    return this.http.post<StartWebCallResponse>('/api/voice/web-calls', {});
  }
}
