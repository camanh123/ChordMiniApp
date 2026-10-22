/**
 * API Key Management Hook
 * Provides centralized API key management functionality
 */

import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { 
  ApiCredentialService,
  ApiKeyStatus, 
  ApiKeyValidationResult, 
  RateLimitInfo 
} from '@/types/apiKeyTypes';
import { apiKeyStorage } from '@/services/cache/apiKeyStorageService';
import { apiKeyValidation } from '@/services/api/apiKeyValidationService';

export const useApiKeys = () => {
  const { t } = useI18n();
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>({
    musicAi: { hasKey: false, isValid: false },
    gemini: { hasKey: false, isValid: false },
    songformerAccess: { hasKey: false, isValid: false }
  });
  const [isLoading, setIsLoading] = useState(true);
  const [rateLimitInfo, setRateLimitInfo] = useState<RateLimitInfo | null>(null);

  // Initialize API key status
  const refreshApiKeyStatus = useCallback(async () => {
    try {
      const status = await apiKeyValidation.getApiKeyStatus();
      setApiKeyStatus(status);
      
      // Get rate limit info for Gemini
      const geminiRateLimit = await apiKeyValidation.getGeminiRateLimitInfo();
      setRateLimitInfo(geminiRateLimit);
    } catch (error) {
      console.error('Failed to refresh API key status:', error);
    }
  }, []);

  // Load initial status
  useEffect(() => {
    const loadInitialStatus = async () => {
      setIsLoading(true);
      await refreshApiKeyStatus();
      setIsLoading(false);
    };
    
    loadInitialStatus();
  }, [refreshApiKeyStatus]);

  // Validate and store API key
  const setApiKey = useCallback(async (
    service: ApiCredentialService, 
    apiKey: string
  ): Promise<ApiKeyValidationResult> => {
    let validationResult: ApiKeyValidationResult;
    
    // Validate the API key
    if (service === 'musicAi') {
      validationResult = await apiKeyValidation.validateMusicAiKey(apiKey);
    } else if (service === 'gemini') {
      validationResult = await apiKeyValidation.validateGeminiKey(apiKey);
    } else {
      validationResult = await apiKeyValidation.validateSongformerAccessCode(apiKey);
    }
    
    if (validationResult.isValid) {
      // Store the key if validation succeeds
      await apiKeyStorage.storeApiKey(service, apiKey);
      
      // Refresh status
      await refreshApiKeyStatus();
    }
    
    return validationResult;
  }, [refreshApiKeyStatus]);

  // Remove API key
  const removeApiKey = useCallback(async (service: ApiCredentialService) => {
    apiKeyStorage.removeApiKey(service);
    await refreshApiKeyStatus();
  }, [refreshApiKeyStatus]);

  // Get API key for service calls
  const getApiKey = useCallback(async (service: ApiCredentialService): Promise<string | null> => {
    return await apiKeyStorage.getApiKey(service);
  }, []);

  // Check if service requires user API key
  const requiresApiKey = useCallback((service: ApiCredentialService): boolean => {
    return apiKeyValidation.requiresUserApiKey(service);
  }, []);

  // Check if service is available (has valid key or fallback available)
  const isServiceAvailable = useCallback((service: ApiCredentialService): boolean => {
    const status = apiKeyStatus[service];

    if (service === 'musicAi') {
      // Music.ai requires user API key
      return status.hasKey && status.isValid;
    }

    if (service === 'gemini') {
      // Gemini has fallback to app key
      return true; // Always available with fallback
    }

    if (service === 'songformerAccess') {
      if (process.env.NODE_ENV !== 'production') {
        return true;
      }

      return status.hasKey && status.isValid;
    }

    return false;
  }, [apiKeyStatus]);



  // Get service availability message
  const getServiceMessage = useCallback((service: ApiCredentialService): string => {
    const status = apiKeyStatus[service];
    
    if (service === 'musicAi') {
      if (!status.hasKey) {
        return t('settings.msg.musicAiRequired');
      }
      if (!status.isValid) {
        return t('settings.msg.musicAiInvalid');
      }
      return t('settings.msg.musicAiReady');
    }
    
    if (service === 'gemini') {
      if (!status.hasKey) {
        return t('settings.msg.geminiQuota');
      }
      if (!status.isValid) {
        return t('settings.msg.geminiInvalid');
      }
      return t('settings.msg.geminiReady');
    }

    if (service === 'songformerAccess') {
      if (process.env.NODE_ENV !== 'production') {
        return t('settings.msg.songformerDev');
      }
      if (!status.hasKey) {
        return t('settings.msg.songformerRequired');
      }
      if (!status.isValid) {
        return t('settings.msg.songformerInvalid');
      }
      return t('settings.msg.songformerReady');
    }
    
    return t('settings.msg.unknown');
  }, [apiKeyStatus, t]);

  // Check if we're near rate limits
  const isNearRateLimit = useCallback((service: 'gemini'): boolean => {
    if (service === 'gemini' && rateLimitInfo) {
      return rateLimitInfo.isNearLimit;
    }
    return false;
  }, [rateLimitInfo]);

  // Check if we're over rate limits
  const isOverRateLimit = useCallback((service: 'gemini'): boolean => {
    if (service === 'gemini' && rateLimitInfo) {
      return rateLimitInfo.isOverLimit;
    }
    return false;
  }, [rateLimitInfo]);

  // Clear all API keys
  const clearAllApiKeys = useCallback(async () => {
    apiKeyStorage.clearAllApiKeys();
    await refreshApiKeyStatus();
  }, [refreshApiKeyStatus]);

  // Check if encryption is supported
  const isEncryptionSupported = useCallback((): boolean => {
    return apiKeyStorage.isEncryptionSupported();
  }, []);

  return {
    // State
    apiKeyStatus,
    isLoading,
    rateLimitInfo,
    
    // Actions
    setApiKey,
    removeApiKey,
    getApiKey,
    refreshApiKeyStatus,
    clearAllApiKeys,
    
    // Utilities
    requiresApiKey,
    isServiceAvailable,
    getServiceMessage,
    isNearRateLimit,
    isOverRateLimit,
    isEncryptionSupported
  };
};
