import { Controller, Post, Get, Body, Req, Res, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { CommitTransactionDto } from './dto/commit-transaction.dto';
import { RefundTransactionDto } from './dto/refund-transaction.dto';
import { Response, Request } from 'express';

@ApiTags('payment')
@Controller()
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(private readonly paymentService: PaymentService) {}

  private maskToken(token?: string): string {
    if (!token) {
      return '(empty)';
    }
    if (token.length <= 10) {
      return `${token.substring(0, 4)}...`;
    }
    return `${token.substring(0, 10)}...`;
  }

  private parseResponseCode(value: any): number | null {
    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    return null;
  }

  private isAuthorizedResult(result: any): boolean {
    const status = String(result?.status || '').toUpperCase();
    const responseCode = this.parseResponseCode(result?.response_code);
    return status === 'AUTHORIZED' && (responseCode === 0 || responseCode === null);
  }

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
   * Incluye token_ws cuando está disponible para que payment-gateway.tsx
   * pueda invocar checkPendingPayment(tokenWs) directamente, en lugar de
   * caer al polling. Alineado con payments_controller.ts del backend.
   */
  private buildResultUrl(
    status: 'success' | 'rejected' | 'aborted' | 'error',
    result?: any,
    token?: string,
  ): string {
    const params = new URLSearchParams({ status });

    if (result?.amount !== undefined) {
      params.set('amount', String(result.amount));
    }

    if (result?.buy_order) {
      params.set('buyOrder', String(result.buy_order));
    }

    // Incluir token_ws para que el frontend pueda confirmar directamente
    // sin necesidad de polling (alineado con payments_controller.ts del backend)
    if (token) {
      params.set('token_ws', token);
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

    const requestTag = `[${req.method}] ${req.originalUrl || req.url}`;

    this.logger.log(`${requestTag} 📥 WEBPAY CALLBACK RECIBIDO`);
    this.logger.log(`${requestTag} Content-Type=${req.headers['content-type'] || '(none)'}`);
    this.logger.log(`${requestTag} Body keys=${Object.keys(body).join(',') || '(none)'}`);
    this.logger.debug(`${requestTag} Body=${JSON.stringify(body)}`);
    this.logger.debug(`${requestTag} Query=${JSON.stringify(query)}`);

    const callbackOrder = this.extractCallbackOrder(body, query);
    const callbackSession = this.extractCallbackSession(body, query);
    const cancelToken = this.extractCancelToken(body, query);

    this.logger.log(
      `${requestTag} callback metadata | buyOrder=${callbackOrder || '(none)'} | sessionId=${callbackSession || '(none)'} | cancelToken=${this.maskToken(cancelToken || undefined)}`,
    );

    // ─── Caso 1: Usuario anuló la compra en Webpay ───
    if (cancelToken) {
      this.logger.warn(`${requestTag} ⛔ Compra anulada por usuario en Webpay (TBK_TOKEN presente)`);
      await this.paymentService.markAsAborted(cancelToken, callbackOrder || undefined, callbackSession || undefined);
      return res.redirect(this.buildResultUrl('aborted', undefined, cancelToken));
    }

    // ─── Caso 2: Extraemos el token de commit ───
    const token = this.extractCommitToken(body, query);
    this.logger.log(`${requestTag} token detectado=${this.maskToken(token || undefined)}`);

    if (!token) {
      // Sin token ni TBK_TOKEN → probable timeout o abandono
      if (callbackOrder || callbackSession) {
        this.logger.warn(`${requestTag} ⛔ Retorno Webpay sin token: probable timeout o abandono`);
        await this.paymentService.markAsAborted(undefined, callbackOrder || undefined, callbackSession || undefined);
        return res.redirect(this.buildResultUrl('aborted'));
      }

      this.logger.error(`${requestTag} ❌ Retorno de Webpay sin datos identificables`);
      this.logger.error(`${requestTag} Verificar parsing body y headers del callback`);
      return res.redirect(this.buildResultUrl('error'));
    }

    // ─── Caso 3: Commit normal con token ───
    try {
      this.logger.log(`${requestTag} 🔄 Confirmando transacción con Transbank token=${this.maskToken(token)}`);

      const result = await this.paymentService.commit({ token });

      this.logger.log(
        `${requestTag} ✅ Resultado Transbank | status=${result?.status} | response_code=${this.parseResponseCode(result?.response_code)}`,
      );
      this.logger.debug(`${requestTag} payload resultado=${JSON.stringify(result)}`);

      if (this.isAuthorizedResult(result)) {
        const successUrl = this.buildResultUrl('success', result, token);
        this.logger.log(`${requestTag} 🚀 Pago exitoso, redirigiendo a ${successUrl}`);
        return res.redirect(successUrl);
      }

      this.logger.warn(
        `${requestTag} ⛔ Pago rechazado por Transbank | status=${result?.status} | response_code=${this.parseResponseCode(result?.response_code)}`,
      );
      return res.redirect(this.buildResultUrl('rejected', undefined, token));
    } catch (error) {
      this.logger.error(`${requestTag} ❌ Error en commit con Transbank: ${error?.message || error}`);
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
    this.logger.log(
      `[POST /create] amount=${createTransactionDto?.amount} buyOrder=${createTransactionDto?.buyOrder || '(auto)'} sessionId=${createTransactionDto?.sessionId || '(auto)'}`,
    );
    this.logger.debug(`[POST /create] returnUrl=${createTransactionDto?.returnUrl}`);
    return this.paymentService.create(createTransactionDto);
  }

  /**
   * POST /commit — Endpoint dual:
   *
   * 1. LLAMADA PROGRAMÁTICA (webpay_service.ts del backend):
   *    Content-Type: application/json, body: { token: "..." }
   *    → Devuelve JSON con el resultado del commit de Transbank.
   *
   * 2. CALLBACK DE TRANSBANK (browser redirect tras pago):
   *    Content-Type: application/x-www-form-urlencoded, body: token_ws=...
   *    → Redirige al deep link autobox://payment-result
   *
   * IMPORTANTE: Se usa @Req() directo para leer body crudo sin que
   * ValidationPipe/whitelist descarte los campos form-urlencoded de Transbank.
   */
  @Post('commit')
  @ApiOperation({ summary: 'Webpay commit — JSON API o callback de Transbank' })
  @ApiBody({ type: CommitTransactionDto, required: false })
  @ApiResponse({ status: 200, description: 'Commit result (JSON API call).' })
  @ApiResponse({ status: 302, description: 'Redirects to app (Transbank browser callback).' })
  async commit(@Req() req: Request, @Res() res: Response) {
    const contentType = req.headers['content-type'] || '';
    const hasProgrammaticToken = !!req.body?.token && !req.body?.token_ws && !req.body?.TBK_TOKEN;
    const isJsonCall = contentType.includes('application/json') || hasProgrammaticToken;

    this.logger.log(
      `[POST /commit] entrada contentType=${contentType || '(none)'} jsonCall=${isJsonCall} token=${this.maskToken(req.body?.token || req.body?.token_ws)}`,
    );

    // Llamada programática desde webpay_service.ts → devolver JSON directamente
    if (isJsonCall) {
      const token = req.body?.token;
      if (!token) {
        this.logger.warn('[POST /commit] jsonCall sin token');
        return res.status(400).json({ message: 'token is required' });
      }
      try {
        const result = await this.paymentService.commit({ token });
        this.logger.log(
          `[POST /commit] jsonCall ok | token=${this.maskToken(token)} | status=${result?.status} | response_code=${this.parseResponseCode(result?.response_code)}`,
        );
        return res.json(result);
      } catch (error: any) {
        const status = error?.status || error?.response?.status || 500;
        this.logger.error(`[POST /commit] jsonCall error | token=${this.maskToken(token)} | status=${status} | msg=${error?.message || 'Commit failed'}`);
        return res.status(status).json({ message: error?.message || 'Commit failed' });
      }
    }

    // Callback de Transbank (form-urlencoded desde el navegador) → redirigir
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

  /**
   * POST /api/webpay/callback — Alias para despliegues con prefijo /api.
   */
  @Post('api/webpay/callback')
  @ApiOperation({ summary: 'Webpay payment callback alias with /api prefix (POST)' })
  @ApiBody({ type: CommitTransactionDto, required: false })
  @ApiResponse({ status: 302, description: 'Redirects to app with payment result.' })
  async webpayApiCallbackPost(@Req() req: Request, @Res() res: Response) {
    return this.handleCommit(req, res);
  }

  /**
   * GET /api/webpay/callback — Alias fallback para despliegues con prefijo /api.
   */
  @Get('api/webpay/callback')
  @ApiOperation({ summary: 'Webpay payment callback alias with /api prefix (GET)' })
  @ApiResponse({ status: 302, description: 'Redirects to app with payment result.' })
  async webpayApiCallbackGet(@Req() req: Request, @Res() res: Response) {
    return this.handleCommit(req, res);
  }

  @Post('status')
  @ApiOperation({ summary: 'Get status of a Webpay transaction' })
  @ApiResponse({ status: 200, description: 'Transaction status retrieved successfully.' })
  status(@Body('token') token: string) {
    this.logger.log(`[POST /status] token=${this.maskToken(token)}`);
    return this.paymentService.status(token);
  }

  @Post('refund')
  @ApiOperation({ summary: 'Refund a Webpay transaction' })
  @ApiResponse({ status: 200, description: 'Transaction refunded successfully.' })
  refund(@Body() refundTransactionDto: RefundTransactionDto) {
    this.logger.log(
      `[POST /refund] token=${this.maskToken(refundTransactionDto?.token)} amount=${refundTransactionDto?.amount}`,
    );
    return this.paymentService.refund(refundTransactionDto);
  }
}