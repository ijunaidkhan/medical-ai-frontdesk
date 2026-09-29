import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthProfile, AuthSession } from '@frontdesk/shared';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { requestMeta } from '../common/request-meta.js';
import type { AuthContext } from './auth-context.js';
import { LOGIN_RATE_LIMIT, REFRESH_RATE_LIMIT } from './auth.constants.js';
import { LoginDto, SwitchPracticeDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { CurrentAuth } from './current-auth.decorator.js';
import { OriginGuard } from './origin.guard.js';
import { Public } from './public.decorator.js';
import { clearRefreshCookie, REFRESH_COOKIE_NAME, setRefreshCookie } from './refresh-cookie.js';

@Controller('auth')
export class AuthController {
  private readonly secureCookie: boolean;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.secureCookie = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  @Public()
  @Throttle({ default: LOGIN_RATE_LIMIT })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSession> {
    const issued = await this.auth.login(dto, requestMeta(request));
    setRefreshCookie(response, issued.refreshToken, issued.refreshExpiresAt, this.secureCookie);
    return issued.session;
  }

  /** Authenticated by the refresh cookie, so it also checks the request Origin (CSRF). */
  @Public()
  @UseGuards(OriginGuard)
  @Throttle({ default: REFRESH_RATE_LIMIT })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<AuthSession> {
    const result = await this.auth.refresh(request.cookies?.[REFRESH_COOKIE_NAME], requestMeta(request));
    if (!result.ok) {
      if (result.clearCookie) {
        clearRefreshCookie(response, this.secureCookie);
      }
      throw new UnauthorizedException('Session expired');
    }
    setRefreshCookie(response, result.refreshToken, result.refreshExpiresAt, this.secureCookie);
    return result.session;
  }

  @Public()
  @UseGuards(OriginGuard)
  @Throttle({ default: REFRESH_RATE_LIMIT })
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.auth.logout(request.cookies?.[REFRESH_COOKIE_NAME], requestMeta(request));
    clearRefreshCookie(response, this.secureCookie);
  }

  @Get('me')
  me(@CurrentAuth() auth: AuthContext): Promise<AuthProfile> {
    return this.auth.getProfile(auth);
  }

  @Post('switch-practice')
  @HttpCode(200)
  async switchPractice(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: SwitchPracticeDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSession> {
    const issued = await this.auth.switchPractice(auth, dto.practiceId, requestMeta(request));
    setRefreshCookie(response, issued.refreshToken, issued.refreshExpiresAt, this.secureCookie);
    return issued.session;
  }
}
