import 'reflect-metadata';
import { UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';
import multipart from '@fastify/multipart';

export async function bootstrap(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  const config = app.get(AppConfig);
  app.getHttpAdapter().getInstance().addHook('onRoute',(options: any) => {
    if(options.url==='/ai/agent' && options.method==='POST') options.bodyLimit=8*1024*1024;
  });
  await app.register(multipart, {
    limits: { fileSize: config.importMaxUploadMb * 1024 * 1024, files: 1 },
  });
  config.validateRuntime();
  app.enableCors({
    origin: config.allowedOrigins,
    credentials: true,
    // Fastify's default CORS method list is limited to GET/HEAD/POST.
    // The editor saves an import draft with PATCH before confirmation and
    // may remove an unconfirmed import with DELETE, so both methods must be
    // advertised for browser preflight requests.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors) => new UnprocessableEntityException(errors),
    }),
  );
  await app.init();
  return app;
}

if (
  process.env.NODE_ENV !== 'test' &&
  process.env.LIVEDOC_SKIP_AUTO_START !== 'true'
) {
  const app = await bootstrap();
  const config = app.get(AppConfig);
  await app.listen({ port: config.port, host: config.host });
}
