import { BadRequestException } from '@nestjs/common';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';

export async function requireMultipartFile(request: FastifyRequest): Promise<MultipartFile> {
  const file = await request.file();
  if (!file) throw new BadRequestException('A multipart file is required.');
  return file;
}

export function multipartField(file: MultipartFile, name: string): string | undefined {
  const value = file.fields[name];
  if (!value || Array.isArray(value) || value.type !== 'field') return undefined;
  return String(value.value);
}
