import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { AgentReply, StartConversationResponse } from '@frontdesk/shared';
import type { Observable } from 'rxjs';

/** A text test chat with the signed-in practice's AI receptionist. The practice is never sent: the server reads it from the session. */
@Injectable({ providedIn: 'root' })
export class AgentApi {
  private readonly http = inject(HttpClient);

  startTestChat(): Observable<StartConversationResponse> {
    return this.http.post<StartConversationResponse>('/api/agent/test-conversations', {});
  }

  sendMessage(conversationId: string, text: string): Observable<AgentReply> {
    return this.http.post<AgentReply>(`/api/agent/test-conversations/${encodeURIComponent(conversationId)}/messages`, { text });
  }
}
