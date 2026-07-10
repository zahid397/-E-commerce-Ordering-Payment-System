import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class InitiatePaymentDto {
  @ApiProperty({ enum: ['stripe', 'bkash'], example: 'stripe' })
  @IsIn(['stripe', 'bkash'])
  provider: 'stripe' | 'bkash';
}
