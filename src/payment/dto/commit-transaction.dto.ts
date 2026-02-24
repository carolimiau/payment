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
}
