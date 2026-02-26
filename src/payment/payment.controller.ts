import { Controller, Post, Get, Body, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { CommitTransactionDto } from './dto/commit-transaction.dto';
import { RefundTransactionDto } from './dto/refund-transaction.dto';
import { Response, Request } from 'express';

@ApiTags('payment')
@Controller()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  // ──────────────────────────────────────────────────────────────────
  // Helpers internos para extraer datos del callback raw de Webpay
  // ──────────────────────────────────────────────────────────────────

  /**
   * Extrae el token de commit desde body o query (token_ws o token).
   * Webpay envía "token_ws" como form-urlencoded en el POST callback.
   */
  private extractCommitToken(body: Record<string, any>, query: Record<string, any>): string | null {
    return (
      body?.token_ws ||
      query?.token_ws ||
      body?.token ||
      query?.token ||
      null
    );
  }

  /**
   * Extrae el token de cancelación (TBK_TOKEN).
   * Webpay lo envía cuando el usuario anula la compra en el formulario.
   */
  private extractCancelToken(body: Record<string, any>, query: Record<string, any>): string | null {
    return body?.TBK_TOKEN || query?.TBK_TOKEN || null;
  }

  /**
   * Extrae buyOrder desde los distintos campos que Webpay puede enviar.
   */
  private extractCallbackOrder(body: Record<string, any>, query: Record<string, any>): string | null {
    return body?.buy_order || query?.buy_order || body?.TBK_ORDEN_COMPRA || query?.TBK_ORDEN_COMPRA || null;
  }

  /**
   * Extrae sessionId desde los distintos campos que Webpay puede enviar.
   */
  private extractCallbackSession(body: Record<string, any>, query: Record<string, any>): string | null {
    return body?.session_id || query?.session_id || body?.TBK_ID_SESION || query?.TBK_ID_SESION || null;
  }

  /**
   * Construye la URL de resultado para redirigir a la app.
   */
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

  // ──────────────────────────────────────────────────────────────────
  // Handler central del callback de Webpay (POST y GET)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Maneja el retorno de Webpay después de la autorización bancaria.
   * Lee directamente de req.body y req.query para evitar que
   * ValidationPipe/whitelist descarte los campos form-urlencoded
   * que envía Webpay (token_ws, TBK_TOKEN, etc.).
   */
  private async handleCommit(req: Request, res: Response) {
    const body = req.body || {};
    const query = req.query || {};

    // Log diagnóstico: ver exactamente qué llega del callback
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📥 WEBPAY CALLBACK RECIBIDO');
    console.log('   Método:', req.method);
    console.log('   Content-Type:', req.headers['content-type'] || '(ninguno)');
    console.log('   Body keys:', Object.keys(body));
    console.log('   Body:', JSON.stringify(body));
    console.log('   Query:', JSON.stringify(query));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const callbackOrder = this.extractCallbackOrder(body, query);
    const callbackSession = this.extractCallbackSession(body, query);
    const cancelToken = this.extractCancelToken(body, query);

    // ─── Caso 1: Usuario anuló la compra en Webpay ───
    if (cancelToken) {
      console.warn('⛔ Compra anulada por usuario en Webpay (TBK_TOKEN presente)');
      await this.paymentService.markAsAborted(cancelToken, callbackOrder || undefined, callbackSession || undefined);
      return res.redirect(this.buildResultUrl('aborted'));
    }

    // ─── Caso 2: Extraemos el token de commit ───
    const token = this.extractCommitToken(body, query);

    if (!token) {
      // Sin token ni TBK_TOKEN → probable timeout o abandono
      if (callbackOrder || callbackSession) {
        console.warn('⛔ Retorno Webpay sin token: probable timeout o abandono');
        await this.paymentService.markAsAborted(undefined, callbackOrder || undefined, callbackSession || undefined);
        return res.redirect(this.buildResultUrl('aborted'));
      }

      console.error('❌ Retorno de Webpay sin ningún dato identificable');
      console.error('   Esto indica que el body no fue parseado correctamente.');
      console.error('   Verificar que express.urlencoded() esté habilitado en main.ts');
      return res.redirect(this.buildResultUrl('error'));
    }

    // ─── Caso 3: Commit normal con token ───
    try {
      console.log('🔄 Confirmando transacción con Transbank, token:', token.substring(0, 15) + '...');

      const result = await this.paymentService.commit({ token });

      console.log('✅ Resultado Transbank:', JSON.stringify(result));

      if (result.status === 'AUTHORIZED' && result.response_code === 0) {
        const successUrl = this.buildResultUrl('success', result);
        console.log('🚀 Pago exitoso, redirigiendo a:', successUrl);
        return res.redirect(successUrl);
      }

      console.warn('⛔ Pago rechazado por Transbank. response_code:', result.response_code, 'status:', result.status);
      return res.redirect(this.buildResultUrl('rejected'));
    } catch (error) {
      console.error('❌ Error en commit con Transbank:', error?.message || error);
      return res.redirect(this.buildResultUrl('error'));
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Endpoints
  // ──────────────────────────────────────────────────────────────────

  @Post('create')
  @ApiOperation({ summary: 'Create a new Webpay transaction' })
  @ApiResponse({ status: 201, description: 'Transaction created successfully.' })
  create(@Body() createTransactionDto: CreateTransactionDto) {
    return this.paymentService.create(createTransactionDto);
  }

  /**
   * POST /commit — Callback principal de Webpay.
   * Webpay envía un POST form-urlencoded con token_ws después
   * de que el usuario autoriza el pago en el banco.
   * 
   * IMPORTANTE: Se usa @Req() directo en lugar de @Body() + DTO
   * para evitar que ValidationPipe/whitelist descarte los campos
   * form-urlencoded que envía Webpay.
   */
  @Post('commit')
  @ApiOperation({ summary: 'Webpay payment callback (POST)' })
  @ApiBody({ type: CommitTransactionDto, required: false })
  @ApiResponse({ status: 302, description: 'Redirects to app with payment result.' })
  async commit(@Req() req: Request, @Res() res: Response) {
    return this.handleCommit(req, res);
  }

  /**
   * GET /commit — Callback alternativo de Webpay.
   * Algunas versiones/configuraciones de Webpay redirigen con GET
   * pasando token_ws o TBK_TOKEN como query params.
   */
  @Get('commit')
  @ApiOperation({ summary: 'Webpay payment callback (GET fallback)' })
  @ApiResponse({ status: 302, description: 'Redirects to app with payment result.' })
  async commitGet(@Req() req: Request, @Res() res: Response) {
    return this.handleCommit(req, res);
  }

  /**
   * POST /webpay/callback — Alias de callback para despliegues
   * que tienen configurado TBK_RETURN_URL con esta ruta.
   */
  @Post('webpay/callback')
  @ApiOperation({ summary: 'Webpay payment callback alias (POST)' })
  @ApiBody({ type: CommitTransactionDto, required: false })
  @ApiResponse({ status: 302, description: 'Redirects to app with payment result.' })
  async webpayCallbackPost(@Req() req: Request, @Res() res: Response) {
    return this.handleCommit(req, res);
  }

  /**
   * GET /webpay/callback — Alias fallback para callback.
   */
  @Get('webpay/callback')
  @ApiOperation({ summary: 'Webpay payment callback alias (GET)' })
  @ApiResponse({ status: 302, description: 'Redirects to app with payment result.' })
  async webpayCallbackGet(@Req() req: Request, @Res() res: Response) {
    return this.handleCommit(req, res);
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