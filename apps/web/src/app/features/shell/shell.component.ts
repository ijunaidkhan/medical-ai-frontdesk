import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { errorMessage } from '../../core/api/api-error';
import { AuthService } from '../../core/auth/auth.service';
import { ROLE_LABELS } from '../../core/labels';

/** The frame around every signed-in page: practice, person, navigation and sign-out. */
@Component({
  selector: 'app-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShellComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly roleLabels = ROLE_LABELS;
  protected readonly switching = signal(false);
  protected readonly switchError = signal<string | null>(null);
  private leaving = false;

  constructor() {
    // If the session ends for any reason other than the person choosing to sign out
    // (for example it expired and could not be renewed), go back to the login page
    // and return here afterwards.
    effect(() => {
      if (!this.auth.isAuthenticated() && !this.leaving) {
        void this.router.navigate(['/login'], { queryParams: { returnUrl: this.router.url } });
      }
    });
  }

  protected async signOut(): Promise<void> {
    this.leaving = true;
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }

  protected async switchPractice(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const target = select.value;
    if (target === this.auth.practiceId() || this.switching()) {
      return;
    }
    this.switchError.set(null);
    this.switching.set(true);
    try {
      await this.auth.switchPractice(target);
      // Land somewhere every role may see: the new practice may not offer the page they were on.
      await this.router.navigateByUrl('/dashboard');
    } catch (error) {
      select.value = this.auth.practiceId() ?? '';
      this.switchError.set(errorMessage(error, 'Could not switch practice.'));
    } finally {
      this.switching.set(false);
    }
  }
}
