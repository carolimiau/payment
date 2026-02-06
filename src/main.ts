import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common'; // 👈 IMPORTANTE: Importar esto

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 🔥 0. ACTIVAR VALIDACIÓN (CRÍTICO PARA LOS DTOs) 🔥
  // Sin esto, @IsNumber, @IsString, etc., NO funcionan.
  app.useGlobalPipes(new ValidationPipe({
    transform: true, // Convierte tipos (ej: "100" string a 100 number si el DTO lo pide)
    whitelist: true, // Elimina datos extra que no estén en el DTO
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