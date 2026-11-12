import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { Allow } from 'class-validator';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import type { AccessContext } from '../common/types.js';
import { WritingSkillsService } from './writing-skills.service.js';
import type { SaveWritingSkillInput, SkillParameter } from './writing-skills.types.js';
import type { ExecutionPlan } from './document-agent.types.js';

export class SaveWritingSkillDto implements SaveWritingSkillInput {
  @Allow() name!: string;
  @Allow() description!: string;
  @Allow() parameters!: SkillParameter[];
  @Allow() steps!: ExecutionPlan['steps'];
  @Allow() allowed_tools!: string[];
  @Allow() acceptance!: string[];
  @Allow() template_id?: string;
  @Allow() enabled?: boolean;
  @Allow() expected_revision?: number;
}

class DeleteWritingSkillDto {
  @Allow() expected_revision!: number;
}

@Controller('ai/skills')
export class WritingSkillsController {
  constructor(private readonly skills: WritingSkillsService) {}

  @Get() list(@CurrentAccess() context: AccessContext) {
    return this.skills.list(context);
  }

  @Get(':id') get(@CurrentAccess() context: AccessContext, @Param('id') id: string) {
    return this.skills.get(context, id);
  }

  @Post() create(@CurrentAccess() context: AccessContext, @Body() input: SaveWritingSkillDto) {
    return this.skills.save(context, input);
  }

  @Patch(':id') update(@CurrentAccess() context: AccessContext, @Param('id') id: string, @Body() input: SaveWritingSkillDto) {
    return this.skills.save(context, input, id);
  }

  @Delete(':id') async remove(@CurrentAccess() context: AccessContext, @Param('id') id: string, @Body() input: DeleteWritingSkillDto) {
    await this.skills.delete(context, id, input.expected_revision);
    return { deleted: true };
  }
}
