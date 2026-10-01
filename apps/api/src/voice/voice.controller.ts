import { Body, Controller, Header, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/public.decorator.js';
import { toTwilioParams, TwilioSignatureGuard } from './twilio-signature.guard.js';
import { hangupResponse } from './twiml.js';
import { VoiceService } from './voice.service.js';

const TWIML = 'text/xml; charset=utf-8';

/**
 * Twilio's requests about phone calls. Public (no login: Twilio is the caller), so
 * every request must pass the signature check first; with voice switched off these
 * routes do not exist. The per-IP rate limit is skipped because all calls arrive from
 * Twilio's few addresses: per-practice and per-caller limits take its place.
 */
@Public()
@SkipThrottle()
@UseGuards(TwilioSignatureGuard)
@Controller('voice')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  /** A call came in: decide whether the AI answers, and how. */
  @Post('incoming')
  @HttpCode(200)
  @Header('Content-Type', TWIML)
  incoming(@Body() body: unknown): Promise<string> {
    return this.voice.handleIncoming(toTwilioParams(body) ?? {});
  }

  /** The voice session ended. For now the call simply ends; hand-over arrives with the next steps. */
  @Post('action')
  @HttpCode(200)
  @Header('Content-Type', TWIML)
  action(): string {
    return hangupResponse();
  }
}
