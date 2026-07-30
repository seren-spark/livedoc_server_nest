import 'reflect-metadata';
import { UnprocessableEntityException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';

export async function bootstrap(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  const config = app.get(AppConfig);
  config.validateRuntime();
  app.enableCors({
    origin: config.allowedOrigins,
    credentials: true,
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

if (process.env.NODE_ENV !== 'test') {
  const app = await bootstrap();
  const config = app.get(AppConfig);
  await app.listen({ port: config.port, host: config.host });
}
