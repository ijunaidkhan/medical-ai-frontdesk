import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, type MemberSummary, type Role } from '@frontdesk/shared';
import { loadForPractice } from '../../core/api/load-state';
import { PracticeApi } from '../../core/api/practice-api';
import { AuthService } from '../../core/auth/auth.service';
import { formatDateTime } from '../../core/format';
import { auditLabel, PERMISSION_DESCRIPTIONS, ROLE_LABELS, ROLE_LABELS_PLURAL } from '../../core/labels';

const RECENT_ACTIVITY_COUNT = 5;

/** Everything shown here comes from the API for the signed-in practice; nothing is sample data. */
@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink],
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardPage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(PracticeApi);

  protected readonly roleLabels = ROLE_LABELS;
  protected readonly roleLabelsPlural = ROLE_LABELS_PLURAL;
  protected readonly permissionDescriptions = PERMISSION_DESCRIPTIONS;
  protected readonly auditLabel = auditLabel;
  protected readonly formatDateTime = formatDateTime;

  protected readonly practice = loadForPractice(this.auth, () => this.api.practice());
  protected readonly members = loadForPractice(this.auth, () => this.api.members(), () => this.auth.can('members:read'));
  protected readonly activity = loadForPractice(
    this.auth,
    () => this.api.auditLogs({ limit: RECENT_ACTIVITY_COUNT }),
    () => this.auth.can('audit:read'),
  );

  /** What the current role allows, in plain words. */
  protected readonly allowed = computed(() => {
    const role = this.auth.role();
    return role === null ? [] : PERMISSIONS.filter((permission) => ROLE_PERMISSIONS[role].includes(permission));
  });

  protected readonly roleCounts = computed(() => {
    const state = this.members();
    return state.status === 'ready' ? countByRole(state.data) : [];
  });
}

function countByRole(members: MemberSummary[]): Array<{ role: Role; count: number }> {
  const active = members.filter((member) => member.status === 'active');
  return ROLES.map((role) => ({ role, count: active.filter((member) => member.role === role).length })).filter(
    (entry) => entry.count > 0,
  );
}
