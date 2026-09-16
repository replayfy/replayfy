-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "WorkspaceEnv" AS ENUM ('PRODUCTION', 'STAGING', 'DEVELOPMENT');

-- CreateEnum
CREATE TYPE "WorkspacePlan" AS ENUM ('FREE', 'STARTER', 'GROWTH', 'SCALE', 'BUSINESS', 'ENTERPRISE', 'PRO', 'TEAM');

-- CreateEnum
CREATE TYPE "DataRegion" AS ENUM ('US', 'EU');

-- CreateEnum
CREATE TYPE "AskOutcome" AS ENUM ('ANSWERED', 'REFUSED_OFFTOPIC', 'REFUSED_INJECTION', 'RATE_LIMITED', 'BUDGET_EXCEEDED', 'UNAVAILABLE', 'ERROR');

-- CreateEnum
CREATE TYPE "LlmProviderMode" AS ENUM ('DISABLED', 'PLATFORM', 'BYOK');

-- CreateEnum
CREATE TYPE "ResultSetKind" AS ENUM ('QUERY', 'SNAPSHOT');

-- CreateEnum
CREATE TYPE "KnowledgeSource" AS ENUM ('USER_PROVIDED', 'CONFIRMED', 'INFERRED');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('LINEAR', 'GITHUB', 'SLACK', 'PAGERDUTY', 'WEBHOOK', 'JIRA', 'LARK', 'SENTRY');

-- CreateEnum
CREATE TYPE "PendingActionStatus" AS ENUM ('PENDING', 'EXECUTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AlertMetric" AS ENUM ('crashes', 'backendFail', 'slowApi', 'frustrated', 'formAbandon', 'navLoop', 'convFailure', 'convSuccess', 'healthScore');

-- CreateEnum
CREATE TYPE "AlertComparator" AS ENUM ('ABOVE', 'BELOW', 'DROP_PCT');

-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('METRIC', 'ISSUE_RECURRENCE', 'INCIDENT_RECURRENCE', 'FUNNEL_CONVERSION');

-- CreateEnum
CREATE TYPE "ApiKeyScope" AS ENUM ('PUBLIC', 'SERVER', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('LIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "SignalPolarity" AS ENUM ('POSITIVE', 'NEGATIVE');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'ACK', 'RESOLVED');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED', 'REGRESSED');

-- CreateEnum
CREATE TYPE "PlaylistKind" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "CohortKind" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('COMMENT_MENTION', 'SESSION_ERROR', 'COHORT_GROWTH', 'PLAYLIST_SHARED', 'TEAM_INVITE_SENT', 'TEAM_INVITE_ACCEPTED', 'STORAGE_THRESHOLD', 'RAGE_CLUSTER', 'CSV_EXPORT_READY', 'SHARE_VIEWED', 'ALERT_TRIGGERED', 'SYSTEM');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "initials" TEXT,
    "avatarUrl" TEXT,
    "passwordHash" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerification" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordReset" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MagicLink" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MagicLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "env" "WorkspaceEnv" NOT NULL DEFAULT 'PRODUCTION',
    "plan" "WorkspacePlan" NOT NULL DEFAULT 'FREE',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripeSubStatus" TEXT,
    "stripePriceId" TEXT,
    "stripePriceAmountCents" INTEGER,
    "currentPeriodEnd" TIMESTAMP(3),
    "overageBlockedAt" TIMESTAMP(3),
    "usageWarnedPeriod" TEXT,
    "usageWarnedPct" INTEGER,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "aiPurchasedCredits" BIGINT NOT NULL DEFAULT 0,
    "swatch" TEXT,
    "dataRegion" "DataRegion",
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "samplingRate" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "samplingConfig" JSONB,
    "retentionConfig" JSONB,
    "recordingConfig" JSONB,
    "maskingConfig" JSONB,
    "aiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "avgOrderValueCents" INTEGER,
    "allowedHosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AskQuery" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "outcome" "AskOutcome" NOT NULL,
    "scopeScoreX100" INTEGER,
    "category" TEXT,
    "model" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AskQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceLlmConfig" (
    "workspaceId" INTEGER NOT NULL,
    "mode" "LlmProviderMode" NOT NULL DEFAULT 'PLATFORM',
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "apiKeyCipher" BYTEA,
    "apiKeyIv" BYTEA,
    "apiKeyTag" BYTEA,
    "apiKeyLast4" TEXT,
    "guardModel" TEXT,
    "causeModel" TEXT,
    "askModel" TEXT,
    "dailyTokenBudget" INTEGER NOT NULL DEFAULT 1000000,
    "tokensUsedToday" INTEGER NOT NULL DEFAULT 0,
    "budgetDay" DATE,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceLlmConfig_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "WorkspacePerfDaily" (
    "workspaceId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "lcpSum" BIGINT NOT NULL DEFAULT 0,
    "lcpMax" INTEGER NOT NULL DEFAULT 0,
    "slowCount" INTEGER NOT NULL DEFAULT 0,
    "poorCount" INTEGER NOT NULL DEFAULT 0,
    "lcpSamples" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "clsP75X1000" INTEGER NOT NULL DEFAULT 0,
    "fidP75" INTEGER NOT NULL DEFAULT 0,
    "longTaskSum" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspacePerfDaily_pkey" PRIMARY KEY ("workspaceId","day")
);

-- CreateTable
CREATE TABLE "WorkspaceLatencyDaily" (
    "workspaceId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "p95Ms" INTEGER NOT NULL DEFAULT 0,
    "avgMs" INTEGER NOT NULL DEFAULT 0,
    "maxMs" INTEGER NOT NULL DEFAULT 0,
    "slowCalls" INTEGER NOT NULL DEFAULT 0,
    "samples" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceLatencyDaily_pkey" PRIMARY KEY ("workspaceId","day")
);

-- CreateTable
CREATE TABLE "WorkspaceSignalDaily" (
    "workspaceId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "frustrated" INTEGER NOT NULL DEFAULT 0,
    "backendFail" INTEGER NOT NULL DEFAULT 0,
    "slowApi" INTEGER NOT NULL DEFAULT 0,
    "formAbandon" INTEGER NOT NULL DEFAULT 0,
    "navLoop" INTEGER NOT NULL DEFAULT 0,
    "crashes" INTEGER NOT NULL DEFAULT 0,
    "convSuccess" INTEGER NOT NULL DEFAULT 0,
    "convFailure" INTEGER NOT NULL DEFAULT 0,
    "healthScore" INTEGER NOT NULL DEFAULT 100,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceSignalDaily_pkey" PRIMARY KEY ("workspaceId","day")
);

-- CreateTable
CREATE TABLE "WorkspaceStats" (
    "workspaceId" INTEGER NOT NULL,
    "sessionsTotal" INTEGER NOT NULL DEFAULT 0,
    "playlistsTotal" INTEGER NOT NULL DEFAULT 0,
    "usersTotal" INTEGER NOT NULL DEFAULT 0,
    "cohortsTotal" INTEGER NOT NULL DEFAULT 0,
    "commentsTotal" INTEGER NOT NULL DEFAULT 0,
    "funnelsTotal" INTEGER NOT NULL DEFAULT 0,
    "liveSessions" INTEGER NOT NULL DEFAULT 0,
    "storageBytes" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceStats_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "WorkspaceSnapshot" (
    "workspaceId" INTEGER NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshotAt" TIMESTAMP(3),
    "overview" JSONB,
    "metrics" JSONB,
    "narrative" TEXT,
    "narrativeModel" TEXT,
    "narrativeAt" TIMESTAMP(3),
    "storylineIntervalHours" INTEGER NOT NULL DEFAULT 12,
    "factsFingerprint" TEXT,
    "storylineText" TEXT,
    "storylineConfidence" INTEGER,
    "storylineCitations" JSONB,
    "storylineModel" TEXT,
    "storylineAt" TIMESTAMP(3),
    "healthExplanations" JSONB,
    "aiPassAt" TIMESTAMP(3),
    "aiVersion" TEXT,
    "intelIntervalHours" INTEGER NOT NULL DEFAULT 6,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceSnapshot_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "WorkspaceInsight" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceIncidentId" INTEGER,
    "sourceIssueId" INTEGER,
    "explanation" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "actionKind" TEXT NOT NULL,
    "actionRef" TEXT NOT NULL,
    "actionHref" TEXT NOT NULL,
    "citations" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "aiVersion" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "userCount" INTEGER NOT NULL DEFAULT 0,
    "deltaPctX100" INTEGER NOT NULL DEFAULT 0,
    "impactCents" INTEGER NOT NULL DEFAULT 0,
    "rank" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "polarity" "SignalPolarity" NOT NULL DEFAULT 'NEGATIVE',
    "locusScreen" TEXT,
    "locusElement" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER,
    "kind" TEXT NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "stripeType" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "stripeObjectId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsageLedger" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER,
    "surface" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicroCents" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCreditPurchase" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "credits" BIGINT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "stripeEventId" TEXT NOT NULL,
    "stripeObjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCreditPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionBillingLedger" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "sessionPublicId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "platform" TEXT,
    "durationMs" INTEGER,
    "billedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionBillingLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceBillingUsage" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceBillingUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentExecution" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "conversationId" TEXT,
    "capability" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "permitted" BOOLEAN NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "writes" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "input" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentResultSet" (
    "id" TEXT NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "kind" "ResultSetKind" NOT NULL,
    "filter" JSONB,
    "sessionIds" JSONB,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentResultSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceKnowledge" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" "KnowledgeSource" NOT NULL DEFAULT 'USER_PROVIDED',
    "confidence" INTEGER NOT NULL DEFAULT 100,
    "learnedById" INTEGER,
    "learnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceKnowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceIntegration" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "externalTeamId" TEXT,
    "connectedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPendingAction" (
    "id" TEXT NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "conversationId" TEXT,
    "capability" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "preview" JSONB NOT NULL,
    "status" "PendingActionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPendingAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentConversation" (
    "conversationId" TEXT NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "turns" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentConversation_pkey" PRIMARY KEY ("conversationId","workspaceId")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AlertKind" NOT NULL DEFAULT 'METRIC',
    "metric" "AlertMetric",
    "comparator" "AlertComparator",
    "threshold" DOUBLE PRECISION,
    "issueId" INTEGER,
    "incidentId" INTEGER,
    "funnelId" INTEGER,
    "stepIndex" INTEGER,
    "windowDays" INTEGER,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emailTo" TEXT,
    "destinations" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER NOT NULL,
    "lastValue" DOUBLE PRECISION,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "tokenHash" TEXT NOT NULL,
    "sentById" INTEGER,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "ApiKeyScope" NOT NULL DEFAULT 'PUBLIC',
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "envs" TEXT[],
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EndUser" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "distinctId" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "initials" TEXT,
    "plan" TEXT,
    "browser" TEXT,
    "browserVersion" TEXT,
    "os" TEXT,
    "osVersion" TEXT,
    "device" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "flag" TEXT,
    "viewport" TEXT,
    "timezone" TEXT,
    "ip" TEXT,
    "customProps" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "EndUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" SERIAL NOT NULL,
    "publicId" TEXT NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "endUserId" INTEGER,
    "anonymousId" TEXT,
    "status" "SessionStatus" NOT NULL DEFAULT 'LIVE',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "rageCount" INTEGER NOT NULL DEFAULT 0,
    "deadCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "sessionScore" INTEGER NOT NULL DEFAULT 100,
    "consoleCount" INTEGER NOT NULL DEFAULT 0,
    "consoleErrorCount" INTEGER NOT NULL DEFAULT 0,
    "networkCount" INTEGER NOT NULL DEFAULT 0,
    "dataSizeBytes" BIGINT NOT NULL DEFAULT 0,
    "startUrl" TEXT,
    "entryReferrer" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "revId" TEXT,
    "platform" TEXT,
    "sdkName" TEXT,
    "sdkVersion" TEXT,
    "appVersion" TEXT,
    "appBuild" TEXT,
    "userAgent" TEXT,
    "viewport" TEXT,
    "browser" TEXT,
    "browserVersion" TEXT,
    "os" TEXT,
    "osVersion" TEXT,
    "device" TEXT,
    "deviceModel" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "flag" TEXT,
    "timezone" TEXT,
    "ip" TEXT,
    "customProps" JSONB,
    "bookmarked" BOOLEAN NOT NULL DEFAULT false,
    "viewed" BOOLEAN NOT NULL DEFAULT false,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "eventNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "worstLcp" INTEGER,
    "worstClsX1000" INTEGER,
    "worstFid" INTEGER,
    "worstInp" INTEGER,
    "worstFcp" INTEGER,
    "worstTtfb" INTEGER,
    "longTaskCount" INTEGER NOT NULL DEFAULT 0,
    "longTaskTotalMs" INTEGER NOT NULL DEFAULT 0,
    "longTaskSlowestMs" INTEGER NOT NULL DEFAULT 0,
    "peakHeapBytes" BIGINT NOT NULL DEFAULT 0,
    "coldStartMs" INTEGER,
    "firstMeaningfulRenderMs" INTEGER,
    "worstTapResponseMs" INTEGER,
    "firstNetworkTtfbMs" INTEGER,
    "worstFrameDropPct" INTEGER,
    "frozenFrameCount" INTEGER NOT NULL DEFAULT 0,
    "anrCount" INTEGER NOT NULL DEFAULT 0,
    "worstMemoryRssMb" INTEGER,
    "worstThermalState" INTEGER,
    "batteryDrainPctPerMin" INTEGER,
    "tapCount" INTEGER NOT NULL DEFAULT 0,
    "nativeSnapshotCount" INTEGER NOT NULL DEFAULT 0,
    "excludedShort" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "polarity" "SignalPolarity" NOT NULL,
    "screen" TEXT,
    "element" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "incidentId" INTEGER,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "signalType" TEXT NOT NULL,
    "polarity" "SignalPolarity" NOT NULL,
    "screen" TEXT NOT NULL DEFAULT '',
    "element" TEXT NOT NULL DEFAULT '',
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "rank" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "userCount" INTEGER NOT NULL DEFAULT 0,
    "deltaPctX100" INTEGER NOT NULL DEFAULT 0,
    "impactCents" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Storyline" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "incidentId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "factsText" TEXT,
    "causeText" TEXT,
    "causeModel" TEXT,
    "reportJson" JSONB,

    CONSTRAINT "Storyline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyCluster" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "pathKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "failRate" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "successRate" INTEGER NOT NULL DEFAULT 0,
    "exampleSessionId" INTEGER,
    "exampleSuccessSessionId" INTEGER,

    CONSTRAINT "JourneyCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "isCrash" BOOLEAN NOT NULL DEFAULT false,
    "errorClass" TEXT NOT NULL DEFAULT 'error',
    "behavioral" BOOLEAN NOT NULL DEFAULT false,
    "errorType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "culprit" TEXT NOT NULL DEFAULT '',
    "platform" TEXT NOT NULL DEFAULT '',
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "rank" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "userCount" INTEGER NOT NULL DEFAULT 0,
    "firstRelease" TEXT NOT NULL DEFAULT '',
    "lastRelease" TEXT NOT NULL DEFAULT '',
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "lastSessionId" INTEGER,
    "lastPublicId" TEXT,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueOccurrence" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "endUserId" INTEGER,
    "fingerprint" TEXT NOT NULL,
    "isCrash" BOOLEAN NOT NULL DEFAULT false,
    "errorClass" TEXT NOT NULL DEFAULT 'error',
    "errorType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "culprit" TEXT NOT NULL DEFAULT '',
    "platform" TEXT NOT NULL DEFAULT '',
    "screen" TEXT NOT NULL DEFAULT '',
    "release" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionShare" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "panels" JSONB NOT NULL,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "firstViewedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SessionShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionSegment" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "segmentPublicId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "mongoBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionPath" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "SessionPath_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionTag" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "SessionTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Playlist" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "ownerId" INTEGER,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "kind" "PlaylistKind" NOT NULL DEFAULT 'MANUAL',
    "filter" JSONB,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Playlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaylistSession" (
    "id" SERIAL NOT NULL,
    "playlistId" INTEGER NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaylistSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cohort" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "ownerId" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "CohortKind" NOT NULL DEFAULT 'MANUAL',
    "filter" JSONB,
    "membersCount" INTEGER NOT NULL DEFAULT 0,
    "lastComputedAt" TIMESTAMP(3),
    "createdByAi" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cohort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohortMember" (
    "id" SERIAL NOT NULL,
    "cohortId" INTEGER NOT NULL,
    "endUserId" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CohortMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "authorId" INTEGER,
    "body" TEXT NOT NULL,
    "atMs" INTEGER NOT NULL,
    "parentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Funnel" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "ownerId" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "steps" JSONB NOT NULL,
    "filter" JSONB,
    "windowDays" INTEGER NOT NULL DEFAULT 7,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdByAi" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Funnel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceConversionDaily" (
    "workspaceId" INTEGER NOT NULL,
    "funnelId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "entered" INTEGER NOT NULL DEFAULT 0,
    "converted" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceConversionDaily_pkey" PRIMARY KEY ("workspaceId","funnelId","day")
);

-- CreateTable
CREATE TABLE "WorkspaceEngagementDaily" (
    "workspaceId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "dau" INTEGER NOT NULL DEFAULT 0,
    "mau" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "newUsers" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceEngagementDaily_pkey" PRIMARY KEY ("workspaceId","day")
);

-- CreateTable
CREATE TABLE "WorkspaceMobilePerfDaily" (
    "workspaceId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "mobileSessions" INTEGER NOT NULL DEFAULT 0,
    "anrSessions" INTEGER NOT NULL DEFAULT 0,
    "frozenSessions" INTEGER NOT NULL DEFAULT 0,
    "anrSum" INTEGER NOT NULL DEFAULT 0,
    "frozenSum" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceMobilePerfDaily_pkey" PRIMARY KEY ("workspaceId","day")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerification_tokenHash_key" ON "EmailVerification"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailVerification_userId_idx" ON "EmailVerification"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordReset_userId_idx" ON "PasswordReset"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MagicLink_tokenHash_key" ON "MagicLink"("tokenHash");

-- CreateIndex
CREATE INDEX "MagicLink_userId_idx" ON "MagicLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_stripeCustomerId_key" ON "Workspace"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "Workspace_stripeSubscriptionId_stripePriceId_idx" ON "Workspace"("stripeSubscriptionId", "stripePriceId");

-- CreateIndex
CREATE INDEX "AskQuery_workspaceId_createdAt_idx" ON "AskQuery"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AskQuery_userId_createdAt_idx" ON "AskQuery"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "WorkspacePerfDaily_workspaceId_day_idx" ON "WorkspacePerfDaily"("workspaceId", "day" DESC);

-- CreateIndex
CREATE INDEX "WorkspaceLatencyDaily_workspaceId_day_idx" ON "WorkspaceLatencyDaily"("workspaceId", "day" DESC);

-- CreateIndex
CREATE INDEX "WorkspaceSignalDaily_workspaceId_day_idx" ON "WorkspaceSignalDaily"("workspaceId", "day" DESC);

-- CreateIndex
CREATE INDEX "WorkspaceStats_storageBytes_idx" ON "WorkspaceStats"("storageBytes");

-- CreateIndex
CREATE INDEX "WorkspaceSnapshot_snapshotAt_idx" ON "WorkspaceSnapshot"("snapshotAt");

-- CreateIndex
CREATE INDEX "WorkspaceSnapshot_aiPassAt_idx" ON "WorkspaceSnapshot"("aiPassAt");

-- CreateIndex
CREATE INDEX "WorkspaceInsight_workspaceId_rank_idx" ON "WorkspaceInsight"("workspaceId", "rank" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInsight_workspaceId_key_key" ON "WorkspaceInsight"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_stripeEventId_key" ON "BillingEvent"("stripeEventId");

-- CreateIndex
CREATE INDEX "BillingEvent_workspaceId_createdAt_idx" ON "BillingEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingEvent_kind_createdAt_idx" ON "BillingEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "BillingEvent_kind_stripeObjectId_idx" ON "BillingEvent"("kind", "stripeObjectId");

-- CreateIndex
CREATE INDEX "AiUsageLedger_workspaceId_createdAt_idx" ON "AiUsageLedger"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiCreditPurchase_stripeEventId_key" ON "AiCreditPurchase"("stripeEventId");

-- CreateIndex
CREATE INDEX "AiCreditPurchase_workspaceId_createdAt_idx" ON "AiCreditPurchase"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SessionBillingLedger_sessionPublicId_key" ON "SessionBillingLedger"("sessionPublicId");

-- CreateIndex
CREATE INDEX "SessionBillingLedger_workspaceId_periodMonth_idx" ON "SessionBillingLedger"("workspaceId", "periodMonth");

-- CreateIndex
CREATE INDEX "WorkspaceBillingUsage_periodMonth_id_idx" ON "WorkspaceBillingUsage"("periodMonth", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceBillingUsage_workspaceId_periodMonth_key" ON "WorkspaceBillingUsage"("workspaceId", "periodMonth");

-- CreateIndex
CREATE INDEX "AgentExecution_workspaceId_createdAt_idx" ON "AgentExecution"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AgentResultSet_expiresAt_idx" ON "AgentResultSet"("expiresAt");

-- CreateIndex
CREATE INDEX "WorkspaceKnowledge_workspaceId_idx" ON "WorkspaceKnowledge"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceKnowledge_workspaceId_key_key" ON "WorkspaceKnowledge"("workspaceId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceIntegration_workspaceId_provider_key" ON "WorkspaceIntegration"("workspaceId", "provider");

-- CreateIndex
CREATE INDEX "AgentPendingAction_workspaceId_userId_status_idx" ON "AgentPendingAction"("workspaceId", "userId", "status");

-- CreateIndex
CREATE INDEX "AgentPendingAction_expiresAt_idx" ON "AgentPendingAction"("expiresAt");

-- CreateIndex
CREATE INDEX "AgentConversation_updatedAt_idx" ON "AgentConversation"("updatedAt");

-- CreateIndex
CREATE INDEX "Alert_active_id_idx" ON "Alert"("active", "id");

-- CreateIndex
CREATE INDEX "Alert_workspaceId_createdAt_idx" ON "Alert"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "WorkspaceMember_workspaceId_idx" ON "WorkspaceMember"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_workspaceId_idx" ON "Invite"("workspaceId");

-- CreateIndex
CREATE INDEX "Invite_email_idx" ON "Invite"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_workspaceId_idx" ON "ApiKey"("workspaceId");

-- CreateIndex
CREATE INDEX "ApiKey_prefix_idx" ON "ApiKey"("prefix");

-- CreateIndex
CREATE INDEX "EndUser_workspaceId_lastSeenAt_idx" ON "EndUser"("workspaceId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "EndUser_workspaceId_isOnline_idx" ON "EndUser"("workspaceId", "isOnline");

-- CreateIndex
CREATE INDEX "EndUser_workspaceId_country_idx" ON "EndUser"("workspaceId", "country");

-- CreateIndex
CREATE INDEX "EndUser_workspaceId_os_idx" ON "EndUser"("workspaceId", "os");

-- CreateIndex
CREATE INDEX "EndUser_isOnline_lastSeenAt_idx" ON "EndUser"("isOnline", "lastSeenAt");

-- CreateIndex
CREATE INDEX "EndUser_email_idx" ON "EndUser" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "EndUser_name_idx" ON "EndUser" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "EndUser_workspaceId_distinctId_key" ON "EndUser"("workspaceId", "distinctId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_publicId_key" ON "Session"("publicId");

-- CreateIndex
CREATE INDEX "Session_workspaceId_startedAt_idx" ON "Session"("workspaceId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "Session_workspaceId_id_idx" ON "Session"("workspaceId", "id" DESC);

-- CreateIndex
CREATE INDEX "Session_workspaceId_durationMs_idx" ON "Session"("workspaceId", "durationMs" DESC);

-- CreateIndex
CREATE INDEX "Session_workspaceId_status_idx" ON "Session"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Session_endUserId_startedAt_idx" ON "Session"("endUserId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "Session_workspaceId_endUserId_idx" ON "Session"("workspaceId", "endUserId");

-- CreateIndex
CREATE INDEX "Session_workspaceId_anonymousId_idx" ON "Session"("workspaceId", "anonymousId");

-- CreateIndex
CREATE INDEX "Session_workspaceId_endedAt_idx" ON "Session"("workspaceId", "endedAt" DESC);

-- CreateIndex
CREATE INDEX "Session_workspaceId_bookmarked_idx" ON "Session"("workspaceId", "bookmarked");

-- CreateIndex
CREATE INDEX "Session_workspaceId_sessionScore_idx" ON "Session"("workspaceId", "sessionScore");

-- CreateIndex
CREATE INDEX "Session_workspaceId_worstLcp_idx" ON "Session"("workspaceId", "worstLcp");

-- CreateIndex
CREATE INDEX "Session_excludedShort_endedAt_idx" ON "Session"("excludedShort", "endedAt");

-- CreateIndex
CREATE INDEX "Session_status_endedAt_idx" ON "Session"("status", "endedAt");

-- CreateIndex
CREATE INDEX "Session_eventNames_idx" ON "Session" USING GIN ("eventNames" array_ops);

-- CreateIndex
CREATE INDEX "Session_platform_startedAt_idx" ON "Session"("platform", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "Signal_workspaceId_type_screen_occurredAt_idx" ON "Signal"("workspaceId", "type", "screen", "occurredAt");

-- CreateIndex
CREATE INDEX "Signal_incidentId_workspaceId_sessionId_idx" ON "Signal"("incidentId", "workspaceId", "sessionId");

-- CreateIndex
CREATE INDEX "Signal_sessionId_idx" ON "Signal"("sessionId");

-- CreateIndex
CREATE INDEX "Incident_workspaceId_status_polarity_rank_idx" ON "Incident"("workspaceId", "status", "polarity", "rank" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Incident_workspaceId_signalType_screen_element_status_key" ON "Incident"("workspaceId", "signalType", "screen", "element", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Storyline_incidentId_key" ON "Storyline"("incidentId");

-- CreateIndex
CREATE INDEX "Storyline_workspaceId_day_idx" ON "Storyline"("workspaceId", "day");

-- CreateIndex
CREATE INDEX "JourneyCluster_workspaceId_day_failRate_idx" ON "JourneyCluster"("workspaceId", "day", "failRate" DESC);

-- CreateIndex
CREATE INDEX "JourneyCluster_workspaceId_day_successRate_idx" ON "JourneyCluster"("workspaceId", "day", "successRate" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "JourneyCluster_workspaceId_day_pathKey_key" ON "JourneyCluster"("workspaceId", "day", "pathKey");

-- CreateIndex
CREATE INDEX "Issue_workspaceId_status_rank_idx" ON "Issue"("workspaceId", "status", "rank" DESC);

-- CreateIndex
CREATE INDEX "Issue_workspaceId_status_lastSeenAt_idx" ON "Issue"("workspaceId", "status", "lastSeenAt" DESC);

-- CreateIndex
CREATE INDEX "Issue_workspaceId_rank_idx" ON "Issue"("workspaceId", "rank" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Issue_workspaceId_fingerprint_key" ON "Issue"("workspaceId", "fingerprint");

-- CreateIndex
CREATE INDEX "IssueOccurrence_sessionId_idx" ON "IssueOccurrence"("sessionId");

-- CreateIndex
CREATE INDEX "IssueOccurrence_workspaceId_fingerprint_idx" ON "IssueOccurrence"("workspaceId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "IssueOccurrence_sessionId_fingerprint_key" ON "IssueOccurrence"("sessionId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "SessionShare_token_key" ON "SessionShare"("token");

-- CreateIndex
CREATE INDEX "SessionShare_sessionId_idx" ON "SessionShare"("sessionId");

-- CreateIndex
CREATE INDEX "SessionShare_workspaceId_idx" ON "SessionShare"("workspaceId");

-- CreateIndex
CREATE INDEX "SessionSegment_sessionId_idx" ON "SessionSegment"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionSegment_sessionId_sequence_key" ON "SessionSegment"("sessionId", "sequence");

-- CreateIndex
CREATE INDEX "SessionPath_sessionId_sequence_idx" ON "SessionPath"("sessionId", "sequence");

-- CreateIndex
CREATE INDEX "SessionTag_sessionId_key_idx" ON "SessionTag"("sessionId", "key");

-- CreateIndex
CREATE INDEX "Playlist_workspaceId_idx" ON "Playlist"("workspaceId");

-- CreateIndex
CREATE INDEX "PlaylistSession_playlistId_idx" ON "PlaylistSession"("playlistId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaylistSession_playlistId_sessionId_key" ON "PlaylistSession"("playlistId", "sessionId");

-- CreateIndex
CREATE INDEX "Cohort_workspaceId_idx" ON "Cohort"("workspaceId");

-- CreateIndex
CREATE INDEX "CohortMember_cohortId_idx" ON "CohortMember"("cohortId");

-- CreateIndex
CREATE INDEX "CohortMember_endUserId_idx" ON "CohortMember"("endUserId");

-- CreateIndex
CREATE UNIQUE INDEX "CohortMember_cohortId_endUserId_key" ON "CohortMember"("cohortId", "endUserId");

-- CreateIndex
CREATE INDEX "Comment_sessionId_atMs_idx" ON "Comment"("sessionId", "atMs");

-- CreateIndex
CREATE INDEX "Comment_workspaceId_createdAt_idx" ON "Comment"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Funnel_workspaceId_pinned_idx" ON "Funnel"("workspaceId", "pinned");

-- CreateIndex
CREATE INDEX "Funnel_workspaceId_updatedAt_idx" ON "Funnel"("workspaceId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "WorkspaceConversionDaily_workspaceId_day_idx" ON "WorkspaceConversionDaily"("workspaceId", "day" DESC);

-- CreateIndex
CREATE INDEX "WorkspaceEngagementDaily_workspaceId_day_idx" ON "WorkspaceEngagementDaily"("workspaceId", "day" DESC);

-- CreateIndex
CREATE INDEX "WorkspaceMobilePerfDaily_workspaceId_day_idx" ON "WorkspaceMobilePerfDaily"("workspaceId", "day" DESC);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_workspaceId_createdAt_idx" ON "Notification"("workspaceId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MagicLink" ADD CONSTRAINT "MagicLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AskQuery" ADD CONSTRAINT "AskQuery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AskQuery" ADD CONSTRAINT "AskQuery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceLlmConfig" ADD CONSTRAINT "WorkspaceLlmConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspacePerfDaily" ADD CONSTRAINT "WorkspacePerfDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceLatencyDaily" ADD CONSTRAINT "WorkspaceLatencyDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceSignalDaily" ADD CONSTRAINT "WorkspaceSignalDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceStats" ADD CONSTRAINT "WorkspaceStats_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceSnapshot" ADD CONSTRAINT "WorkspaceSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInsight" ADD CONSTRAINT "WorkspaceInsight_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsageLedger" ADD CONSTRAINT "AiUsageLedger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCreditPurchase" ADD CONSTRAINT "AiCreditPurchase_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionBillingLedger" ADD CONSTRAINT "SessionBillingLedger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceBillingUsage" ADD CONSTRAINT "WorkspaceBillingUsage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentExecution" ADD CONSTRAINT "AgentExecution_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentResultSet" ADD CONSTRAINT "AgentResultSet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceKnowledge" ADD CONSTRAINT "WorkspaceKnowledge_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceIntegration" ADD CONSTRAINT "WorkspaceIntegration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPendingAction" ADD CONSTRAINT "AgentPendingAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentConversation" ADD CONSTRAINT "AgentConversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EndUser" ADD CONSTRAINT "EndUser_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_endUserId_fkey" FOREIGN KEY ("endUserId") REFERENCES "EndUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Storyline" ADD CONSTRAINT "Storyline_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Storyline" ADD CONSTRAINT "Storyline_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyCluster" ADD CONSTRAINT "JourneyCluster_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueOccurrence" ADD CONSTRAINT "IssueOccurrence_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueOccurrence" ADD CONSTRAINT "IssueOccurrence_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionShare" ADD CONSTRAINT "SessionShare_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSegment" ADD CONSTRAINT "SessionSegment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionPath" ADD CONSTRAINT "SessionPath_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionTag" ADD CONSTRAINT "SessionTag_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playlist" ADD CONSTRAINT "Playlist_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playlist" ADD CONSTRAINT "Playlist_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistSession" ADD CONSTRAINT "PlaylistSession_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistSession" ADD CONSTRAINT "PlaylistSession_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cohort" ADD CONSTRAINT "Cohort_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cohort" ADD CONSTRAINT "Cohort_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortMember" ADD CONSTRAINT "CohortMember_cohortId_fkey" FOREIGN KEY ("cohortId") REFERENCES "Cohort"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohortMember" ADD CONSTRAINT "CohortMember_endUserId_fkey" FOREIGN KEY ("endUserId") REFERENCES "EndUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Funnel" ADD CONSTRAINT "Funnel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Funnel" ADD CONSTRAINT "Funnel_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceConversionDaily" ADD CONSTRAINT "WorkspaceConversionDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceConversionDaily" ADD CONSTRAINT "WorkspaceConversionDaily_funnelId_fkey" FOREIGN KEY ("funnelId") REFERENCES "Funnel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceEngagementDaily" ADD CONSTRAINT "WorkspaceEngagementDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMobilePerfDaily" ADD CONSTRAINT "WorkspaceMobilePerfDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

