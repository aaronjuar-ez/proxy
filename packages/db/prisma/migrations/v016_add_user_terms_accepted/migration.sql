-- When the person accepted the terms of service and the privacy policy, by signing up past the
-- notice on the sign-in page. Nobody from before the notice has, so it stays empty for them until
-- they are asked to accept.
ALTER TABLE "User" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
