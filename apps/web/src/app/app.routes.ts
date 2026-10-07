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
        path: 'knowledge',
        title: 'Knowledge · AI Front Desk',
        canActivate: [permissionGuard('knowledge:read')],
        loadComponent: () => import('./features/knowledge/knowledge.page').then((m) => m.KnowledgePage),
      },
      {
        path: 'ai',
        title: 'AI receptionist · AI Front Desk',
        canActivate: [permissionGuard('ai:read')],
        loadComponent: () => import('./features/ai-settings/ai-settings.page').then((m) => m.AiSettingsPage),
      },
      {
        path: 'test-chat',
        title: 'Test chat · AI Front Desk',
        canActivate: [permissionGuard('ai:configure')],
        loadComponent: () => import('./features/test-chat/test-chat.page').then((m) => m.TestChatPage),
      },
      {
        path: 'tasks',
        title: 'Tasks · AI Front Desk',
        canActivate: [permissionGuard('tasks:read')],
        loadComponent: () => import('./features/tasks/tasks.page').then((m) => m.TasksPage),
      },
      {
        path: 'conversations',
        title: 'Conversations · AI Front Desk',
        canActivate: [permissionGuard('calls:read')],
        loadComponent: () => import('./features/conversations/conversations.page').then((m) => m.ConversationsPage),
      },
      {
        path: 'conversations/:id',
        title: 'Conversation · AI Front Desk',
        canActivate: [permissionGuard('calls:read')],
        loadComponent: () => import('./features/conversations/conversation.page').then((m) => m.ConversationPage),
      },
      {
        path: 'schedule',
        title: 'Schedule · AI Front Desk',
        canActivate: [permissionGuard('schedule:read')],
        loadComponent: () => import('./features/schedule/schedule.page').then((m) => m.SchedulePage),
      },
      {
        path: 'scheduling-setup',
        title: 'Scheduling setup · AI Front Desk',
        canActivate: [permissionGuard('schedule:read')],
        loadComponent: () => import('./features/scheduling-setup/scheduling-setup.page').then((m) => m.SchedulingSetupPage),
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
