import { Body, Controller, Get, Post } from '@nestjs/common';
import { Allow } from 'class-validator';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import type { AccessContext } from '../common/types.js';
import { WritingPreferencesService } from './writing-preferences.service.js';
import type { PreferenceMutation } from './writing-preferences.types.js';

export class PreferenceMutationDto implements PreferenceMutation {
  @Allow() request_id!: string;
  @Allow() expected_revision!: number;
  @Allow() action!: PreferenceMutation['action'];
  @Allow() id?: string;
  @Allow() text?: string;
  @Allow() replace_ids?: string[];
}

@Controller('ai/agent/preferences')
export class WritingPreferencesController {
  constructor(private readonly preferences: WritingPreferencesService) {}

  @Get() get(@CurrentAccess() context: AccessContext) {
    return this.preferences.get(context);
  }

  @Post() mutate(@CurrentAccess() context: AccessContext, @Body() input: PreferenceMutationDto) {
    return this.preferences.mutate(context, input);
  }
}
