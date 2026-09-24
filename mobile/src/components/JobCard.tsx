import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Keyboard,
  Linking,
  Modal,
  PanResponder,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { styles } from './JobCard.styles';

// How many characters to show in the preview opening overlay.
const TRUNCATE_LENGTH = 120;
// How far (px) a swipe has to travel before it counts as a decision
// instead of springing back to center.
const SWIPE_THRESHOLD = 120;
// How far off-screen the card flies once a decision is made.
const FLY_DISTANCE = 500;
const FLY_DURATION_MS = 220;

export type JobStatus = 'SCRAPED' | 'ANALYZED' | 'APPROVED' | 'SKIPPED' | 'ANSWERED';

export interface JobCardData {
  id: string;
  url?: string;
  title: string;
  location: string;
  company: string;
  salary?: string | null;
  postedLabel?: string | null;
  scrapedAt?: string;
  description: string;
  status: JobStatus;
  evaluation: number;
  summary: string;
  answer: string;
  /** Datetime of the last local approve/reject decision — drives History sort. */
  updatedAt?: number;
}

type ExpandedSection = 'none' | 'description' | 'summary' | 'answer';

interface JobCardProps {
  job: JobCardData;
  onApprove: (data: { answer: string }) => void;
  onReject: () => void;
}

const truncate = (text?: string | null) => {
  if (!text) return '';
  return text.length > TRUNCATE_LENGTH ? `${text.slice(0, TRUNCATE_LENGTH).trimEnd()}…` : text;
};

export default function JobCard({ job, onApprove, onReject }: JobCardProps) {
  const [expanded, setExpanded] = useState<ExpandedSection>('none');
  const [answerText, setAnswerText] = useState(job.answer || '');
  const [savedAnswer, setSavedAnswer] = useState(job.answer || '');
  const [approved, setApproved] = useState(job.status === 'APPROVED');
  const [rejected, setRejected] = useState(job.status === 'SKIPPED');
  const [kbHeight, setKbHeight] = useState(0);
  const isDirty = answerText !== savedAnswer;
  const insets = useSafeAreaInsets();
  // Refs so the (single, long-lived) PanResponder always calls the latest
  // version of these without being recreated on every render.
  const expandedRef = useRef(expanded);
  const answerTextRef = useRef(answerText);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);
  useEffect(() => {
    answerTextRef.current = answerText;
  }, [answerText]);

  useEffect(() => {
    setAnswerText(job.answer || '');
    setSavedAnswer(job.answer || '');
    setApproved(job.status === 'APPROVED');
    setRejected(job.status === 'SKIPPED');
    setExpanded('none');
  }, [job.id, job.answer, job.status]);

  // Track the keyboard height manually. KeyboardAvoidingView measures its
  // position relative to its parent, which breaks inside a card that is
  // offset from the top of the screen and wrapped in a transformed view.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) =>
      setKbHeight(e.endCoordinates.height)
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const closeSection = useCallback(() => setExpanded('none'), []);
  const saveAnswer = useCallback(() => {
    setSavedAnswer(answerText);
    Keyboard.dismiss();
    closeSection();
  }, [answerText, closeSection]);

  const position = useRef(new Animated.ValueXY()).current;

  const decide = useCallback(
    (direction: 'right' | 'left') => {
      if (direction === 'right') {
        setSavedAnswer(answerTextRef.current);
        setApproved(true);
        onApprove({ answer: answerTextRef.current });
      } else {
        setRejected(true);
        onReject();
      }
    },
    [onApprove, onReject]
  );
  const decideRef = useRef(decide);
  useEffect(() => {
    decideRef.current = decide;
  }, [decide]);

  const flyAway = useCallback(
    (direction: 'right' | 'left') => {
      const toX = direction === 'right' ? FLY_DISTANCE : -FLY_DISTANCE;
      Animated.timing(position, {
        toValue: { x: toX, y: 0 },
        duration: FLY_DURATION_MS,
        useNativeDriver: true,
      }).start(() => decideRef.current(direction));
    },
    [position]
  );

  const resetPosition = useCallback(() => {
    Animated.spring(position, {
      toValue: { x: 0, y: 0 },
      useNativeDriver: true,
      friction: 6,
    }).start();
  }, [position]);

  const approve = useCallback(() => flyAway('right'), [flyAway]);
  const reject = useCallback(() => flyAway('left'), [flyAway]);

  const openPosting = useCallback(async () => {
    if (!job.url) return;
    try {
      await WebBrowser.openBrowserAsync(job.url);
    } catch {
      Linking.openURL(job.url).catch(() => {});
    }
  }, [job.url]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Capture-phase check: only steal the gesture from a nested ScrollView
      // when the drag is clearly horizontal, so vertical scrolling (and the
      // answer TextInput) keep working normally.
      onMoveShouldSetPanResponderCapture: (_evt, gestureState) => {
        if (expandedRef.current !== 'none') return false;
        return (
          Math.abs(gestureState.dx) > 8 &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.5
        );
      },
      onPanResponderMove: Animated.event([null, { dx: position.x, dy: position.y }], {
        useNativeDriver: false,
      }),
      onPanResponderRelease: (_evt, gestureState) => {
        if (gestureState.dx > SWIPE_THRESHOLD) {
          flyAway('right');
        } else if (gestureState.dx < -SWIPE_THRESHOLD) {
          flyAway('left');
        } else {
          resetPosition();
        }
      },
      onPanResponderTerminate: () => resetPosition(),
    })
  ).current;

  const rotate = position.x.interpolate({
    inputRange: [-FLY_DISTANCE, 0, FLY_DISTANCE],
    outputRange: ['-12deg', '0deg', '12deg'],
  });
  const likeOpacity = position.x.interpolate({
    inputRange: [0, SWIPE_THRESHOLD],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const skipOpacity = position.x.interpolate({
    inputRange: [-SWIPE_THRESHOLD, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  // Read-only overlay (Summary / Description), rendered inside the card.
  const renderOverlay = (title: string, content: string) => (
    <View style={styles.overlay}>
      <View style={styles.overlayHeader}>
        <Text style={styles.overlayTitle}>{title}</Text>
        <View style={styles.overlayHeaderActions}>
          <TouchableOpacity onPress={closeSection} style={styles.closeButton}>
            <Text style={styles.closeButtonText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.overlayContent}>
        <ScrollView
          style={styles.overlayScroll}
          contentContainerStyle={styles.overlayScrollContent}
        >
          <Text style={styles.overlayText}>{content}</Text>
        </ScrollView>
      </View>
    </View>
  );

  // Answer editor lives in a Modal so it is independent of the card's
  // height, position and transform. The bottom padding equals the keyboard
  // height, so the sheet shrinks and the TextInput stays fully visible.
  const renderAnswerModal = () => (
    <Modal
      visible={expanded === 'answer'}
      animationType="slide"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={closeSection}
    >
      <View style={[styles.modalRoot, { paddingBottom: kbHeight > 0 ? kbHeight + insets.bottom : 0 }]}>
        <View style={styles.modalSheet}>
          <View style={styles.overlayHeader}>
            <Text style={styles.overlayTitle}>Answer</Text>
            <View style={styles.overlayHeaderActions}>
              {isDirty && (
                <TouchableOpacity onPress={saveAnswer} style={styles.saveButton}>
                  <Text style={styles.saveButtonText}>Save</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={closeSection} style={styles.closeButton}>
                <Text style={styles.closeButtonText}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
          <TextInput
            style={styles.answerInput}
            value={answerText}
            onChangeText={setAnswerText}
            multiline
            scrollEnabled
            textAlignVertical="top"
            placeholder="Write your answer…"
            placeholderTextColor="#9aa0a6"
            autoFocus
          />
        </View>
      </View>
    </Modal>
  );

  return (
    <Animated.View
      style={[
        styles.card,
        {
          transform: [{ translateX: position.x }, { translateY: position.y }, { rotate }],
        },
      ]}
      {...panResponder.panHandlers}
    >
      <Animated.View pointerEvents="none" style={[styles.swipeBadge, styles.likeBadge, { opacity: likeOpacity }]}>
        <Text style={styles.swipeBadgeText}>APPROVE</Text>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.swipeBadge, styles.skipBadge, { opacity: skipOpacity }]}>
        <Text style={styles.swipeBadgeText}>SKIP</Text>
      </Animated.View>

      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={2}>{job.title}</Text>
        <Text style={styles.company}>{job.company}</Text>
        <Text style={styles.location}>{job.location}</Text>
        {job.url ? (
          <TouchableOpacity onPress={openPosting} style={styles.linkRow} activeOpacity={0.7}>
            <Text style={styles.linkText}>View posting ↗</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} showsVerticalScrollIndicator={false}>
        <TouchableOpacity style={styles.textBlock} activeOpacity={0.7} onPress={() => setExpanded('summary')}><Text style={styles.blockLabel}>Summary</Text><Text style={styles.blockPreview}>{truncate(job.summary)}</Text></TouchableOpacity>
        <TouchableOpacity style={styles.textBlock} activeOpacity={0.7} onPress={() => setExpanded('description')}><Text style={styles.blockLabel}>Description</Text><Text style={styles.blockPreview}>{truncate(job.description)}</Text></TouchableOpacity>
        <TouchableOpacity style={styles.textBlock} activeOpacity={0.7} onPress={() => setExpanded('answer')}>
          <View style={styles.answerLabelRow}><Text style={styles.blockLabel}>Answer</Text>{isDirty && <View style={styles.dirtyDot} />}</View>
          <Text style={styles.blockPreview}>{answerText ? truncate(answerText) : 'Tap to write an answer…'}</Text>
        </TouchableOpacity>
      </ScrollView>
      <View style={styles.evaluationRow}><View style={styles.evaluationBadge}><Text style={styles.evaluationText}>{job.evaluation}</Text><Text style={styles.evaluationSubtext}>/10</Text></View></View>
      <View style={styles.actionRow}>
        <TouchableOpacity style={[styles.rejectButton, rejected && styles.rejectButtonDone]} activeOpacity={0.8} onPress={reject}>
          <Text style={styles.rejectButtonText}>{rejected ? 'Skipped' : 'Reject'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.approveButton, approved && styles.approveButtonDone]} activeOpacity={0.8} onPress={approve}>
          <Text style={styles.approveButtonText}>{approved ? 'Approved ✓' : 'Approve'}</Text>
        </TouchableOpacity>
      </View>
      {expanded === 'description' && renderOverlay('Description', job.description)}
      {expanded === 'summary' && renderOverlay('Summary', job.summary)}
      {renderAnswerModal()}
    </Animated.View>
  );
}