import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

/**
 * Auth bodies. Email is validated as a bounded string, NOT @IsEmail — existing
 * accounts include non-RFC addresses (e.g. `admin@local`) that a strict email
 * check would lock out. The length caps also bound a huge-input DoS. Password
 * STRENGTH policy is intentionally left to a separate product decision; here we
 * only assert presence + a sane max.
 */
export class LoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;
}

export class SignupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}
