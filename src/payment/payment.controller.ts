import { Controller, Post, Get, Body, Query, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { CommitTransactionDto } from './dto/commit-transaction.dto';
import { RefundTransactionDto } from './dto/refund-transaction.dto';
import { Response } from 'express'; // IMPORTANTE: Importar Response de express
import { Request } from 'express';

@ApiTags('payment')
@Controller()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  private extractCommitToken(body: CommitTransactionDto, query: CommitTransactionDto): string | null {
    return (
      body?.token ||
      body?.token_ws ||
      query?.token ||
      query?.token_ws ||
      null
    );
  }

  private extractCancelToken(body: CommitTransactionDto, query: CommitTransactionDto): string | null {
    return body?.TBK_TOKEN || query?.TBK_TOKEN || null;
  }

  private buildResultUrl(status: 'success' | 'rejected' | 'aborted' | 'error', result?: any): string {
    const params = new URLSearchParams({ status });

    if (result?.amount !== undefined) {
      params.set('amount', String(result.amount));
    }

    if (result?.buy_order) {
      params.set('buyOrder', String(result.buy_order));
    }

    return `autobox://payment-result?${params.toString()}`;
  }

  private async handleCommit(
    body: CommitTransactionDto,
    query: CommitTransactionDto,
    _req: Request,
    res: Response,
  ) {
    const cancelToken = this.extractCancelToken(body, query);
    if (cancelToken) {
      console.warn('⛔ Compra anulada por usuario en Webpay');
      await this.paymentService.markAsAborted(cancelToken);
      return res.redirect(this.buildResultUrl('aborted'));
    }

    const token = this.extractCommitToken(body, query);
    if (!token) {
      console.error('❌ Retorno de Webpay sin token válido');
      return res.redirect(this.buildResultUrl('error'));
    }

    try {
      console.log('🔄 Recibiendo retorno de WebPay con token');

      const result = await this.paymentService.commit({ token });

      console.log('✅ Resultado Transbank:', result);

      if (result.status === 'AUTHORIZED' && result.response_code === 0) {
        const successUrl = this.buildResultUrl('success', result);
        console.log('🚀 Redirigiendo a la App:', successUrl);
        return res.redirect(successUrl);
      }

      console.warn('⛔ Pago rechazado o fallido');
      return res.redirect(this.buildResultUrl('rejected'));
    } catch (error) {
      console.error('❌ Error en commit:', error);
      return res.redirect(this.buildResultUrl('aborted'));
    }
  }

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
  async commit(
    @Body() commitTransactionDto: CommitTransactionDto,
    @Query() queryParams: CommitTransactionDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.handleCommit(commitTransactionDto, queryParams, req, res);
  }

  @Get('commit')
  @ApiOperation({ summary: 'Commit callback fallback for Webpay transaction' })
  @ApiResponse({ status: 200, description: 'Transaction callback handled successfully.' })
  async commitGet(
    @Query() queryParams: CommitTransactionDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.handleCommit({}, queryParams, req, res);
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