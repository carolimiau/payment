import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString } from 'class-validator';

export class RefundTransactionDto {
  @ApiProperty({ example: 'e7230e3e-7d9d-4d08-9b0d-7b1c0e3e7d9d', description: 'Token of the transaction to refund' })
  @IsString()
  token: string;

  @ApiProperty({ example: 1000, description: 'Amount to refund' })
  @IsNumber()
  amount: number;
}
