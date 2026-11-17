/**
 * @file 上传请求解析。从 multipart 请求中获取文件与表单字段。
 */
import { BadRequestException } from '@nestjs/common';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';

/**
 * 从 multipart 请求中读取必需的上传文件，缺失时返回请求错误。
 *
 * @param request 当前 Fastify HTTP 请求。
 * @returns MultipartFile 类型的处理结果。
 */
export async function requireMultipartFile(request: FastifyRequest): Promise<MultipartFile> {
  const file = await request.file();
  if (!file) throw new BadRequestException('A multipart file is required.');
  return file;
}

/**
 * 读取并规范化指定 multipart 表单字段。
 *
 * @param file 待上传或解析的文件。
 * @param name 目标名称。
 * @returns 整理后的文本或标识；未找到或不可用时可能为空。
 */
export function multipartField(file: MultipartFile, name: string): string | undefined {
  const value = file.fields[name];
  if (!value || Array.isArray(value) || value.type !== 'field') return undefined;
  return String(value.value);
}
