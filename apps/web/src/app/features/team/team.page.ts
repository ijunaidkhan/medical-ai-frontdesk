import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { loadForPractice } from '../../core/api/load-state';
import { PracticeApi } from '../../core/api/practice-api';
import { AuthService } from '../../core/auth/auth.service';
import { formatDate } from '../../core/format';
import { ROLE_LABELS } from '../../core/labels';

/** Who is on the signed-in practice's team, read-only. */
@Component({
  selector: 'app-team-page',
  templateUrl: './team.page.html',
  styleUrl: './team.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TeamPage {
  protected readonly auth = inject(AuthService);
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly formatDate = formatDate;

  private readonly api = inject(PracticeApi);
  protected readonly members = loadForPractice(this.auth, () => this.api.members());
}
