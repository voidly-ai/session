import type {
  HireRefuseDetail,
  HireRefuseReason,
  ReceivedHireRefuseDetail,
  SessionHireRefused,
  UnknownHireRefuseDetail,
} from "./hire";

type Assert<T extends true> = T;

export type _KnownFlowsOutward = Assert<
  [HireRefuseDetail] extends [ReceivedHireRefuseDetail] ? true : false
>;

export type _ArrivingIsNotOurs = Assert<
  [ReceivedHireRefuseDetail] extends [HireRefuseDetail] ? false : true
>;

export type _LiteralsSurvive = Assert<
  [Extract<ReceivedHireRefuseDetail, "grant_offer_mismatch">] extends [never] ? false : true
>;

export type _StructDetailIsOpen = Assert<
  [SessionHireRefused["detail"]] extends [HireRefuseDetail] ? false : true
>;

export type _NoCastAtTheBoundary = Assert<
  [string] extends [ReceivedHireRefuseDetail] ? true : false
>;

export type _NotExhaustible = Assert<[UnknownHireRefuseDetail] extends [never] ? false : true>;

export type _ReasonStaysClosed = Assert<[string] extends [HireRefuseReason] ? false : true>;
