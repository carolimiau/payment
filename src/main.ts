import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. Configuración de Swagger (Se mantiene igual, ¡muy útil!)
  const config = new DocumentBuilder()
    .setTitle('Payment Service API')
    .setDescription('The Payment Service API description')
    .setVersion('1.0')
    .addTag('payment')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  // 2. CORS Mejorado
  // Permitimos que Render inyecte el origen o usamos '*' por defecto
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // 3. Puerto Dinámico
  // Render usa su propio puerto. Si no lo encuentra, usa el 3001 (Local)
  const port = process.env.PORT || 3001;

  // 4. Escuchar en 0.0.0.0
  // Vital para que Render exponga el servicio a internet
  await app.listen(port, '0.0.0.0');
  
  console.log(`🚀 Payment Service is running on port: ${port}`);
  console.log(`📄 Swagger available at: /api`);
}
bootstrap();