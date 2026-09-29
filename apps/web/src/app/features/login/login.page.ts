import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { PASSWORD_MAX_LENGTH } from '@frontdesk/shared';
import { errorMessage, httpStatusOf } from '../../core/api/api-error';
import { AuthService } from '../../core/auth/auth.service';
import { safeReturnUrl } from '../../core/auth/return-url';

@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule],
  templateUrl: './login.page.html',
  styleUrl: './login.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    email: ['', [Validators.required, Validators.email, Validators.maxLength(254)]],
    password: ['', [Validators.required, Validators.maxLength(PASSWORD_MAX_LENGTH)]],
  });

  protected readonly submitting = signal(false);
  protected readonly revealed = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly attempted = signal(false);
  /** Form controls are not signals; this makes the messages below re-evaluate when a field is touched or edited. */
  private readonly formChanged = toSignal(this.form.events, { initialValue: null });

  protected readonly emailProblem = computed(() => {
    this.attempted();
    this.formChanged();
    const control = this.form.controls.email;
    if (!this.shows(control)) return null;
    return control.hasError('required') ? 'Enter your email address.' : 'Enter a valid email address.';
  });

  protected readonly passwordProblem = computed(() => {
    this.attempted();
    this.formChanged();
    return this.shows(this.form.controls.password) ? 'Enter your password.' : null;
  });

  protected async submit(): Promise<void> {
    this.attempted.set(true);
    this.form.markAllAsTouched();
    if (this.form.invalid || this.submitting()) {
      return;
    }

    this.error.set(null);
    this.submitting.set(true);
    try {
      const { email, password } = this.form.getRawValue();
      await this.auth.login(email, password);
      await this.router.navigateByUrl(safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl')));
    } catch (error) {
      this.error.set(httpStatusOf(error) === 401 ? 'Invalid email or password.' : errorMessage(error));
      this.form.controls.password.reset('');
      // The password box is empty on purpose now; do not also scold the person for leaving it empty.
      this.attempted.set(false);
    } finally {
      this.submitting.set(false);
    }
  }

  private shows(control: { invalid: boolean; touched: boolean }): boolean {
    return control.invalid && (control.touched || this.attempted());
  }
}
