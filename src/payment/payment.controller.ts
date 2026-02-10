import { Controller, Post, Body, Res, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { CommitTransactionDto } from './dto/commit-transaction.dto';
import { RefundTransactionDto } from './dto/refund-transaction.dto';
import { Response } from 'express'; // IMPORTANTE: Importar Response de express

@ApiTags('payment')
@Controller()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('create')
  @ApiOperation({ summary: 'Create a new Webpay transaction' })
  @ApiResponse({ status: 201, description: 'Transaction created successfully.' })
  create(@Body() createTransactionDto: CreateTransactionDto) {
    return this.paymentService.create(createTransactionDto);
  }

  // 🚨 AQUÍ ESTÁ EL CAMBIO IMPORTANTE
  @Post('commit')
  @ApiOperation({ summary: 'Commit a Webpay transaction' })
  @ApiResponse({ status: 200, description: 'Transaction committed successfully.' })
  async commit(@Body() commitTransactionDto: CommitTransactionDto, @Res() res: Response) {
    try {
      console.log('🔄 Recibiendo retorno de WebPay:', commitTransactionDto);
      
      // 1. Ejecutamos la lógica de validación con Transbank
      const result = await this.paymentService.commit(commitTransactionDto);

      console.log('✅ Resultado Transbank:', result);

      // 2. Verificamos si el pago fue autorizado (response_code 0)
      if (result.status === 'AUTHORIZED' && result.response_code === 0) {
        
        // 3. REDIRECCIÓN ÉXITOSA
        // Construimos la URL para despertar a tu App
        // Agregamos datos útiles para que la app sepa qué mostrar
        const successUrl = `autobox://payment-result?status=success&amount=${result.amount}&buyOrder=${result.buy_order}`;
        
        console.log('🚀 Redirigiendo a la App:', successUrl);
        return res.redirect(successUrl);

      } else {
        // 4. REDIRECCIÓN DE RECHAZO (Ej: Sin cupo, clave errónea)
        console.warn('⛔ Pago rechazado o fallido');
        return res.redirect('autobox://payment-result?status=rejected');
      }

    } catch (error) {
      console.error('❌ Error en commit:', error);
      
      // 5. REDIRECCIÓN DE ERROR (Si el usuario anuló o hubo error técnico)
      // Si el usuario da click en "Anular compra" en el formulario de Webpay, suele caer aquí
      return res.redirect('autobox://payment-result?status=aborted');
    }
  }

  @Post('status')
  @ApiOperation({ summary: 'Get status of a Webpay transaction' })
  @ApiResponse({ status: 200, description: 'Transaction status retrieved successfully.' })
  status(@Body('token') token: string) {
    return this.paymentService.status(token);
  }

  @Post('refund')
  @ApiOperation({ summary: 'Refund a Webpay transaction' })
  @ApiResponse({ status: 200, description: 'Transaction refunded successfully.' })
  refund(@Body() refundTransactionDto: RefundTransactionDto) {
    return this.paymentService.refund(refundTransactionDto);
  }
}