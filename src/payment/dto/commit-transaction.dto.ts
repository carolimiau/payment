import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CommitTransactionDto {
  @ApiProperty({ example: 'e7230e3e-7d9d-4d08-9b0d-7b1c0e3e7d9d', description: 'Token received from Webpay', required: false })
  @IsOptional()
  @IsString()
  token?: string;

  @ApiProperty({ example: 'e7230e3e-7d9d-4d08-9b0d-7b1c0e3e7d9d', description: 'Webpay return token (token_ws)', required: false })
  @IsOptional()
  @IsString()
  token_ws?: string;

  @ApiProperty({ example: 'e7230e3e-7d9d-4d08-9b0d-7b1c0e3e7d9d', description: 'Webpay cancellation token (TBK_TOKEN)', required: false })
  @IsOptional()
  @IsString()
  TBK_TOKEN?: string;

  @ApiProperty({ example: 'order-123', description: 'Webpay buy order in timeout/cancel callback', required: false })
  @IsOptional()
  @IsString()
  buy_order?: string;

  @ApiProperty({ example: 'session-123', description: 'Webpay session id in timeout/cancel callback', required: false })
  @IsOptional()
  @IsString()
  session_id?: string;

  @ApiProperty({ example: 'order-123', description: 'Alternative field used by Webpay: TBK_ORDEN_COMPRA', required: false })
  @IsOptional()
  @IsString()
  TBK_ORDEN_COMPRA?: string;

  @ApiProperty({ example: 'session-123', description: 'Alternative field used by Webpay: TBK_ID_SESION', required: false })
  @IsOptional()
  @IsString()
  TBK_ID_SESION?: string;
}
