import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CommitTransactionDto {
  @ApiProperty({ example: 'e7230e3e-7d9d-4d08-9b0d-7b1c0e3e7d9d', description: 'Token received from Webpay' })
  @IsString()
  token: string;
}
