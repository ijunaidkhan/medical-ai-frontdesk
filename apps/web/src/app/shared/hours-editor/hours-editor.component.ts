import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MAX_INTERVALS_PER_DAY, WEEKDAYS, type BusinessHours, type Weekday } from '@frontdesk/shared';
import { WEEKDAY_LABELS } from '../../core/labels';

/**
 * Weekly opening periods, edited as 24-hour text ("09:00" to "17:30"; a browser time box cannot show 24:00).
 * It only reports changes; the page that uses it validates and saves.
 */
@Component({
  selector: 'app-hours-editor',
  templateUrl: './hours-editor.component.html',
  styleUrl: './hours-editor.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HoursEditorComponent {
  readonly hours = input.required<BusinessHours>();
  readonly disabled = input(false);
  /** Makes the field ids unique when several editors are on one page. */
  readonly idPrefix = input('hours');
  /** Who the hours belong to, for screen readers ("Dr Khan, Monday opens"). */
  readonly owner = input('');
  readonly hoursChange = output<BusinessHours>();

  protected readonly weekdays = WEEKDAYS;
  protected readonly weekdayLabels = WEEKDAY_LABELS;
  protected readonly maxPeriods = MAX_INTERVALS_PER_DAY;

  protected label(day: Weekday, what: string): string {
    return `${this.owner() ? `${this.owner()}, ` : ''}${this.weekdayLabels[day]} ${what}`;
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected setTime(day: Weekday, index: number, part: 'open' | 'close', value: string): void {
    this.editDay(day, (periods) => periods.map((period, i) => (i === index ? { ...period, [part]: value } : period)));
  }

  protected addPeriod(day: Weekday): void {
    this.editDay(day, (periods) => (periods.length >= MAX_INTERVALS_PER_DAY ? periods : [...periods, { open: '09:00', close: '17:00' }]));
  }

  protected removePeriod(day: Weekday, index: number): void {
    this.editDay(day, (periods) => periods.filter((_, i) => i !== index));
  }

  private editDay(day: Weekday, edit: (periods: BusinessHours[Weekday]) => BusinessHours[Weekday]): void {
    if (this.disabled()) return;
    this.hoursChange.emit({ ...this.hours(), [day]: edit(this.hours()[day]) });
  }
}
