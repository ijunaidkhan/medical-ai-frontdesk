import { Global, Module } from '@nestjs/common';
import { ActorVerifier } from './actor-verifier.js';
import { TenantDb } from './tenant-db.js';

@Global()
@Module({
  providers: [ActorVerifier, TenantDb],
  exports: [ActorVerifier, TenantDb],
})
export class TenancyModule {}
