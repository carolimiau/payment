import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 🔥 CRÍTICO: Habilitar parsing de form-urlencoded EXPLÍCITAMENTE 🔥
  // Webpay envía callbacks como application/x-www-form-urlencoded, NO JSON.
  // Sin esto, req.body llega vacío en los callbacks de Webpay y el pago falla.
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  // Activar validación para DTOs (no afecta endpoints que usen @Req() directo)
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
  }));

  // 1. Configuración de Swagger
  const config = new DocumentBuilder()
    .setTitle('Payment Service API')
    .setDescription('The Payment Service API description')
    .setVersion('1.0')
    .addTag('payment')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  // 2. CORS Mejorado
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // 3. Puerto Dinámico (Tu lógica está perfecta aquí)
  const port = process.env.PORT || 3001;

  // 4. Escuchar en 0.0.0.0
  await app.listen(port, '0.0.0.0');
  
  console.log(`🚀 Payment Service is running on port: ${port}`);
  console.log(`📄 Swagger available at: /api`);
}
bootstrap();