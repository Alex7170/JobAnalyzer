import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import JobCard, { type JobCardData } from './JobCard';
import { styles } from './JobCards.styles';
import {
  approveJobVacancy,
  fetchNewJobVacancies,
  rejectJobVacancy,
} from '../services/googleSheetsService';
import {
  getPendingAnswers,
  removePendingAnswer,
  savePendingAnswer,
} from '../services/pendingAnswersStorage';

export type JobFilterType = 'priority' | 'all' | 'history';

const isPending = (job: JobCardData) => job.status !== 'APPROVED' && job.status !== 'SKIPPED';
const isDecided = (job: JobCardData) => job.status === 'APPROVED' || job.status === 'SKIPPED';
const getEvaluation = (job: JobCardData) =>
  Number.isFinite(job.evaluation) ? job.evaluation : 0;

function compareByEvaluationAndScrapedDate(a: JobCardData, b: JobCardData) {
  const evaluationDifference = getEvaluation(b) - getEvaluation(a);
  if (evaluationDifference !== 0) return evaluationDifference;

  const aScrapedAt = Date.parse(a.scrapedAt ?? '');
  const bScrapedAt = Date.parse(b.scrapedAt ?? '');
  const aHasValidDate = Number.isFinite(aScrapedAt);
  const bHasValidDate = Number.isFinite(bScrapedAt);

  if (!aHasValidDate) return bHasValidDate ? 1 : 0;
  if (!bHasValidDate) return -1;
  return bScrapedAt - aScrapedAt;
}

export interface JobCardsProps {
  /**
   * Optional initial vacancies. If provided, fetches can still refresh them.
   */
  initialJobs?: JobCardData[];
}

export default function JobCards({ initialJobs }: JobCardsProps) {
  const [jobs, setJobs] = useState<JobCardData[]>(initialJobs || []);
  const [loading, setLoading] = useState<boolean>(!initialJobs || initialJobs.length === 0);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isFallback, setIsFallback] = useState<boolean>(false);
  const [fallbackMessage, setFallbackMessage] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [filter, setFilter] = useState<JobFilterType>('all');

  // Load new vacancies from Google Sheets server
  const loadJobs = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const [result, pendingAnswers] = await Promise.all([
        fetchNewJobVacancies(),
        getPendingAnswers(),
      ]);
      const jobsWithPendingAnswers = result.jobs.map((job) => {
        const pendingAnswer = pendingAnswers[job.id];
        return pendingAnswer === undefined ? job : { ...job, answer: pendingAnswer };
      });
      setJobs(jobsWithPendingAnswers);
      setIsFallback(result.isFallback);
      setFallbackMessage(result.message || null);
      setCurrentIndex(0);
    } catch (err) {
      setError((err as Error).message || 'Failed to fetch job vacancies.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!initialJobs || initialJobs.length === 0) {
      void loadJobs();
    }
  }, [loadJobs, initialJobs]);

  // Filtered list based on selected tab
  const filteredJobs = useMemo(() => {
    switch (filter) {
      case 'priority':
        return jobs.filter((job) => isPending(job) && job.evaluation >= 7);
      case 'history':
        // Most recently decided first. Items decided in a previous session
        // (no local updatedAt yet — the server doesn't persist this) sort
        // to the bottom instead of jumping to the top.
        return jobs.filter(isDecided).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      case 'all':
      default:
        return jobs.filter(isPending).sort(compareByEvaluationAndScrapedDate);
    }
  }, [jobs, filter]);

  // Ensure currentIndex stays within bounds when filter changes
  useEffect(() => {
    if (currentIndex >= filteredJobs.length && filteredJobs.length > 0) {
      setCurrentIndex(filteredJobs.length - 1);
    }
  }, [currentIndex, filteredJobs.length]);

  const currentJob = filteredJobs[currentIndex];

  const handleNext = useCallback(() => {
    if (currentIndex < filteredJobs.length - 1) {
      setCurrentIndex((prev) => prev + 1);
    }
  }, [currentIndex, filteredJobs.length]);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex((prev) => prev - 1);
    }
  }, [currentIndex]);


  const handleApprove = useCallback(
    async ({ answer }: { answer: string }) => {
      if (!currentJob) return;

      const targetId = currentJob.id;
      const decidedAt = Date.now();

      // Optimistically mark as APPROVED
      setJobs((prevJobs) =>
        prevJobs.map((item) =>
          item.id === targetId ? { ...item, status: 'APPROVED', answer, updatedAt: decidedAt } : item
        )
      );

      // Send update to Google Sheets server
      const syncResult = await approveJobVacancy(targetId, answer);
      if (syncResult.success) {
        await removePendingAnswer(targetId);
      } else {
        Alert.alert(
          'Sync Warning',
          `Approved locally, but could not sync to Google Sheets: ${syncResult.error || 'Server error'}`
        );
      }
    },
    [currentJob]
  );

  const handleAnswerSaved = useCallback(async (jobId: string, answer: string) => {
    await savePendingAnswer(jobId, answer);
    setJobs((prevJobs) =>
      prevJobs.map((item) => (item.id === jobId ? { ...item, answer } : item))
    );
  }, []);

  const handleReject = useCallback(async () => {
    if (!currentJob) return;

    const targetId = currentJob.id;
    const decidedAt = Date.now();

    // Optimistically mark as SKIPPED
    setJobs((prevJobs) =>
      prevJobs.map((item) =>
        item.id === targetId ? { ...item, status: 'SKIPPED', updatedAt: decidedAt } : item
      )
    );

    // Send update to Google Sheets server
    const syncResult = await rejectJobVacancy(targetId);
    if (syncResult.success) {
      await removePendingAnswer(targetId);
    } else {
      Alert.alert(
        'Sync Warning',
        `Rejected locally, but could not sync to Google Sheets: ${syncResult.error || 'Server error'}`
      );
    }
  }, [currentJob]);

  // -------------------------------------------------------------
  // Render States: Loading, Error, Empty, Loaded
  // -------------------------------------------------------------

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#2563eb" />
        <Text style={styles.stateTitle}>Connecting to Google Sheets…</Text>
        <Text style={styles.stateSubtitle}>Fetching newly analyzed job vacancies</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centerContainer}>
        <Text style={{ fontSize: 32 }}>⚠️</Text>
        <Text style={styles.stateTitle}>Could Not Load Vacancies</Text>
        <Text style={styles.stateSubtitle}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => loadJobs(false)}>
          <Text style={styles.retryButtonText}>Retry Request</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Top Header & Filters */}
      <View style={styles.topBar}>
        <View style={styles.headerRow}>
          <View style={styles.titleWrapper}>
            <Text style={styles.title}>New Vacancies</Text>
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText}>{filteredJobs.length}</Text>
            </View>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.refreshButton}
              onPress={() => loadJobs(true)}
              disabled={refreshing}
            >
              <Text style={styles.refreshButtonText}>
                {refreshing ? 'Refreshing…' : '⟳ Sync'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Filter Chips */}
        <View style={styles.filterRow}>
          <TouchableOpacity
            style={[styles.filterChip, filter === 'priority' && styles.filterChipActive]}
            onPress={() => {
              setFilter('priority');
              setCurrentIndex(0);
            }}
          >
            <Text
              style={[
                styles.filterChipText,
                filter === 'priority' && styles.filterChipTextActive,
              ]}
            >
              Priority ≥7 ({jobs.filter((j) => isPending(j) && j.evaluation >= 7).length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterChip, filter === 'all' && styles.filterChipActive]}
            onPress={() => {
              setFilter('all');
              setCurrentIndex(0);
            }}
          >
            <Text style={[styles.filterChipText, filter === 'all' && styles.filterChipTextActive]}>
              All ({jobs.filter(isPending).length})
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterChip, filter === 'history' && styles.filterChipActive]}
            onPress={() => {
              setFilter('history');
              setCurrentIndex(0);
            }}
          >
            <Text
              style={[
                styles.filterChipText,
                filter === 'history' && styles.filterChipTextActive,
              ]}
            >
              History ({jobs.filter(isDecided).length})
            </Text>
          </TouchableOpacity>
        </View>

        {/* Fallback data notification banner if running offline */}
        {isFallback && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              {fallbackMessage || 'Running with local sample vacancies'}
            </Text>
          </View>
        )}
      </View>

      {/* Center: JobCard or Empty State */}
      <View style={styles.cardArea}>
        {filteredJobs.length === 0 ? (
          <View style={styles.centerContainer}>
            <Text style={{ fontSize: 40 }}>🎉</Text>
            <Text style={styles.stateTitle}>All Caught Up!</Text>
            <Text style={styles.stateSubtitle}>
              {filter === 'history'
                ? 'Nothing approved or skipped yet.'
                : 'No new job vacancies found in Google Sheets.'}
            </Text>
            <TouchableOpacity style={styles.retryButton} onPress={() => loadJobs(true)}>
              <Text style={styles.retryButtonText}>Check for New Vacancies</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <JobCard
            key={currentJob.id}
            job={currentJob}
            onApprove={handleApprove}
            onReject={handleReject}
            onAnswerSaved={handleAnswerSaved}
            canSwipePrevious={currentIndex > 0}
            canSwipeNext={currentIndex < filteredJobs.length - 1}
            onSwipe={(direction) => {
              if (direction === 'previous') {
                handlePrev();
              } else {
                handleNext();
              }
            }}
          />
        )}
      </View>

      {/* Bottom Bar: Paging Navigation */}
      {filteredJobs.length > 0 && (
        <View style={styles.bottomBar}>
          <TouchableOpacity
            style={[styles.navButton, currentIndex === 0 && styles.navButtonDisabled]}
            disabled={currentIndex === 0}
            onPress={handlePrev}
          >
            <Text style={styles.navButtonText}>◀ Prev</Text>
          </TouchableOpacity>

          <View style={styles.indicatorContainer}>
            <Text style={styles.indicatorText}>
              {currentIndex + 1} of {filteredJobs.length}
            </Text>
          </View>

          <TouchableOpacity
            style={[
              styles.navButton,
              currentIndex >= filteredJobs.length - 1 && styles.navButtonDisabled,
            ]}
            disabled={currentIndex >= filteredJobs.length - 1}
            onPress={handleNext}
          >
            <Text style={styles.navButtonText}>Next ▶</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}