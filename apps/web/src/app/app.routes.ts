import { Routes } from '@angular/router';
import { authGuard, guestGuard, permissionGuard } from './core/auth/guards';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Sign in · AI Front Desk',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/login/login.page').then((m) => m.LoginPage),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./features/shell/shell.component').then((m) => m.ShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        title: 'Dashboard · AI Front Desk',
        loadComponent: () => import('./features/dashboard/dashboard.page').then((m) => m.DashboardPage),
      },
      {
        path: 'team',
        title: 'Team · AI Front Desk',
        canActivate: [permissionGuard('members:read')],
        loadComponent: () => import('./features/team/team.page').then((m) => m.TeamPage),
      },
      {
        path: 'activity',
        title: 'Activity · AI Front Desk',
        canActivate: [permissionGuard('audit:read')],
        loadComponent: () => import('./features/activity/activity.page').then((m) => m.ActivityPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
